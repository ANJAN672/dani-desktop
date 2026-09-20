import { randomUUID } from "node:crypto";

export interface NativeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Tool-specific validation runs before an approval is requested or an action executes. */
  parse: (input: unknown) => unknown;
  /** The authorization broker must approve the exact parsed action. */
  authorize: (input: unknown, context: { taskId: string; toolCallId: string }) => Promise<boolean>;
  execute: (input: unknown, context: { taskId: string; toolCallId: string; signal: AbortSignal }) => Promise<unknown>;
}

export type NativeMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: NativeToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface NativeToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface NativeCompletion {
  content: string | null;
  tool_calls?: NativeToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface NativeInference {
  complete(request: {
    model: string;
    messages: NativeMessage[];
    tools: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
    signal: AbortSignal;
  }): Promise<NativeCompletion>;
}

export type NativeEvent =
  | { type: "tool.started"; tool: string; callId: string }
  | { type: "tool.completed"; tool: string; callId: string; ok: boolean }
  | { type: "text"; text: string };

export interface NativeRun {
  text: string;
  messages: NativeMessage[];
  turns: number;
  toolExecutions: number;
}

function toolResult(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "null").slice(0, 16_000);
}

/** Model-neutral agent loop. The model can propose actions but cannot grant their permissions. */
export async function runNativeDani(input: {
  backend: NativeInference;
  model: string;
  system: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  prompt: string;
  tools: readonly NativeTool[];
  signal?: AbortSignal;
  taskId?: string;
  maxTurns?: number;
  onEvent?: (event: NativeEvent) => void;
}): Promise<NativeRun> {
  const maxTurns = input.maxTurns ?? 12;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 32) throw new Error("Invalid execution limit");
  if (!input.model.trim()) throw new Error("A model must be selected");
  const signal = input.signal ?? new AbortController().signal;
  const taskId = input.taskId ?? randomUUID();
  const tools = new Map<string, NativeTool>();
  for (const tool of input.tools) {
    if (!/^[a-zA-Z_][\w-]{0,63}$/.test(tool.name) || tools.has(tool.name)) throw new Error("Invalid or duplicate tool name");
    tools.set(tool.name, tool);
  }
  const definitions = [...tools.values()].map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const messages: NativeMessage[] = [
    { role: "system", content: input.system },
    ...(input.history ?? []).map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content: input.prompt },
  ];
  const executed = new Map<string, { signature: string; result: string }>();
  let toolExecutions = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal.aborted) throw signal.reason ?? new Error("Execution cancelled");
    const completion = await input.backend.complete({ model: input.model, messages: structuredClone(messages), tools: definitions, signal });
    if (!completion || (completion.content !== null && typeof completion.content !== "string") ||
      (completion.tool_calls !== undefined && !Array.isArray(completion.tool_calls))) {
      throw new Error("Inference returned an invalid completion");
    }
    const calls = completion.tool_calls ?? [];
    if (!calls.length) {
      const text = completion.content?.trim() ?? "";
      if (!text) throw new Error("Inference returned no final answer");
      messages.push({ role: "assistant", content: text });
      input.onEvent?.({ type: "text", text });
      return { text, messages, turns: turn, toolExecutions };
    }
    if (calls.length > 16) throw new Error("Model requested too many tools in one step");
    const unique = new Set<string>();
    for (const call of calls) {
      if (call?.type !== "function" || !call.id || typeof call.function?.name !== "string" ||
        typeof call.function.arguments !== "string" || unique.has(call.id)) {
        throw new Error("Invalid or repeated tool-call identity within completion");
      }
      unique.add(call.id);
    }
    messages.push({ role: "assistant", content: completion.content, tool_calls: calls });
    for (const call of calls) {
      if (signal.aborted) throw signal.reason ?? new Error("Execution cancelled");
      const tool = tools.get(call.function.name);
      const signature = JSON.stringify([call.function.name, call.function.arguments]);
      const previous = executed.get(call.id);
      if (previous && previous.signature !== signature) throw new Error("Model reused a tool-call ID with different arguments");
      if (previous) {
        messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: previous.result });
        continue;
      }
      let result: string;
      let ok = false;
      if (!tool) {
        result = "Tool unavailable; select an allowed capability.";
      } else {
        try {
          const parsed = tool.parse(JSON.parse(call.function.arguments));
          const allowed = await tool.authorize(parsed, { taskId, toolCallId: call.id });
          if (!allowed) {
            result = "Permission denied. Do not repeat without a new authorization.";
          } else {
            input.onEvent?.({ type: "tool.started", tool: tool.name, callId: call.id });
            const output = await tool.execute(parsed, { taskId, toolCallId: call.id, signal });
            toolExecutions += 1;
            result = toolResult(output);
            ok = true;
          }
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          // An execution exception may have occurred AFTER the side effect. Never retry it automatically.
          result = `Action failed or its outcome is uncertain: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}. Reconcile external state before repeating.`;
        }
        input.onEvent?.({ type: "tool.completed", tool: tool.name, callId: call.id, ok });
      }
      executed.set(call.id, { signature, result });
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
    }
  }
  throw new Error("DANI reached the execution limit; task remains unfinished");
}

/** Direct API inference. No Claude Code, Codex, Kilo CLI, or DANI-Free installation is required. */
export function openAICompatibleInference(config: {
  baseUrl: string;
  apiKey: string;
  fetcher?: typeof fetch;
}): NativeInference {
  const base = config.baseUrl.replace(/\/+$/, "");
  const parsed = new URL(base);
  if (!(["https:", "http:"].includes(parsed.protocol)) || parsed.username || parsed.password || !config.apiKey) {
    throw new Error("A valid inference endpoint and API key are required");
  }
  const fetcher = config.fetcher ?? fetch;
  return {
    async complete(request) {
      const response = await fetcher(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: request.model, messages: request.messages, ...(request.tools.length ? { tools: request.tools } : {}) }),
        signal: request.signal,
      });
      if (!response.ok) throw new Error(`Inference HTTP ${response.status}`);
      const body = await response.json() as { choices?: Array<{ message?: NativeCompletion }> };
      const message = body.choices?.[0]?.message;
      if (!message) throw new Error("Provider returned an empty completion");
      return message;
    },
  };
}
