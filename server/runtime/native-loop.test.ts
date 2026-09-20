import { describe, expect, it, vi } from "vitest";
import { openAICompatibleInference, runNativeDani, type NativeCompletion, type NativeInference, type NativeTool } from "./native-loop.ts";

const backend = (...responses: NativeCompletion[]): NativeInference => ({
  complete: vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("Unexpected extra inference call");
    return next;
  }),
});
const call = (id: string, argumentsText = '{"value":"hello"}') => ({
  id,
  type: "function" as const,
  function: { name: "record", arguments: argumentsText },
});
const tool = (execute: NativeTool["execute"] = vi.fn(async () => ({ saved: true })), allow = true): NativeTool => ({
  name: "record",
  description: "Record a safe fixture action",
  parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  parse: (raw) => {
    if (!raw || typeof raw !== "object" || typeof (raw as { value?: unknown }).value !== "string") {
      throw new Error("Invalid tool arguments");
    }
    return raw;
  },
  authorize: vi.fn(async () => allow),
  execute,
});
const run = (provider: NativeInference, tools: NativeTool[] = []) => runNativeDani({
  backend: provider, model: "some/byok-model", system: "You are DANI", prompt: "Do the fixture task", tools,
});

describe("DANI native loop", () => {
  it("works with BYOK-only inference and no DANI-Free proxy or installed agent CLI", async () => {
    const result = await run(backend({ content: "Done" }));
    expect(result).toMatchObject({ text: "Done", turns: 1, toolExecutions: 0 });
    expect(result.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
  });

  it("runs a validated and explicitly authorized tool then returns evidence to the model", async () => {
    const execute = vi.fn(async () => ({ saved: true }));
    const provider = backend({ content: null, tool_calls: [call("call-1")] }, { content: "Recorded" });
    const result = await run(provider, [tool(execute)]);
    expect(result.toolExecutions).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.messages.find((message) => message.role === "tool")).toMatchObject({
      role: "tool", tool_call_id: "call-1", content: '{"saved":true}',
    });
  });

  it("never executes a denied or invalid tool", async () => {
    const execute = vi.fn(async () => "unsafe");
    const denied = await run(backend({ content: null, tool_calls: [call("call-1")] }, { content: "Denied" }), [tool(execute, false)]);
    expect(denied.toolExecutions).toBe(0);
    const invalid = await run(backend({ content: null, tool_calls: [call("call-2", '{"value":123}')] }, { content: "Invalid" }), [tool(execute)]);
    expect(invalid.toolExecutions).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not repeat a tool call when the model replays the same id", async () => {
    const execute = vi.fn(async () => "committed");
    const result = await run(backend({ content: null, tool_calls: [call("same")] }, { content: null, tool_calls: [call("same")] }, { content: "Complete" }), [tool(execute)]);
    expect(result.toolExecutions).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects reused ids with changed arguments and bounds unproductive turns", async () => {
    await expect(run(backend({ content: null, tool_calls: [call("same")] },
      { content: null, tool_calls: [call("same", '{"value":"different"}')] }), [tool()])).rejects.toThrow(/different arguments/);
    await expect(runNativeDani({ backend: backend({ content: null, tool_calls: [call("x")] }), model: "m", system: "s", prompt: "p", tools: [], maxTurns: 1 }))
      .rejects.toThrow(/execution limit/);
  });

  it("sends native tool definitions to a real HTTP-compatible transport without needing a CLI", async () => {
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      expect(JSON.parse(options.body as string)).toMatchObject({ model: "custom/model", messages: [{ role: "user", content: "hello" }] });
      expect(options.headers).toMatchObject({ authorization: "Bearer test-token" });
      return { ok: true, json: async () => ({ choices: [{ message: { content: "Reply" } }] }) } as Response;
    });
    const provider = openAICompatibleInference({ baseUrl: "https://example.test/v1", apiKey: "test-token", fetcher: fetcher as unknown as typeof fetch });
    expect(await provider.complete({ model: "custom/model", messages: [{ role: "user", content: "hello" }], tools: [], signal: new AbortController().signal })).toEqual({ content: "Reply" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
