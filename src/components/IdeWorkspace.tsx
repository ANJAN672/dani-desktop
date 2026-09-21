import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Code2,
  FileCode2,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
  Square,
  TerminalSquare,
} from "lucide-react";
import {
  api,
  useStore,
  useStreaming,
  visibleMessages,
  type InstanceInfo,
  type Message,
  type ModelSelection,
} from "@/state/store";

const STORAGE_KEY = "gooey-pi.workspace-files.v1";
const ENGINEER_NAME = "Gooey Engineer";

type ProjectFile = {
  path: string;
  content: string;
};

const STARTER_FILES: ProjectFile[] = [
  {
    path: "README.md",
    content:
      "# Gooey pi\n\nA small coding workspace backed by the Dani-Free inference proxy and the OMP runtime.\n\n- Dani-Free supplies model inference.\n- OMP owns tools, approvals, sessions, and state.\n- Ask Gooey Engineer to inspect or change the active file.\n",
  },
  {
    path: "package.json",
    content:
      '{\n  "name": "gooey-pi",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build"\n  }\n}\n',
  },
  {
    path: "src/index.ts",
    content:
      'import { createGooeyWorkspace } from "./gooey";\n\nconst workspace = createGooeyWorkspace({\n  name: "gooey-pi",\n  entrypoint: "src/index.ts",\n});\n\nworkspace.start();\n',
  },
  {
    path: "src/gooey.ts",
    content:
      'export type GooeyWorkspaceOptions = {\n  name: string;\n  entrypoint: string;\n};\n\nexport function createGooeyWorkspace(options: GooeyWorkspaceOptions) {\n  return {\n    ...options,\n    start() {\n      console.info(`Gooey pi ready: ${options.name}`);\n    },\n  };\n}\n',
  },
  {
    path: "src/agent.ts",
    content:
      'export function buildAgentPrompt(request: string, activeFile?: string) {\n  return [\n    "You are the coding agent for Gooey pi.",\n    `Request: ${request}`,\n    activeFile ? `Active file:\\n${activeFile}` : "",\n  ]\n    .filter(Boolean)\n    .join("\\n\\n");\n}\n',
  },
];

function readWorkspaceFiles(): ProjectFile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return STARTER_FILES;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return STARTER_FILES;
    const files = parsed.filter(
      (item): item is ProjectFile =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as ProjectFile).path === "string" &&
        typeof (item as ProjectFile).content === "string",
    );
    return files.length ? files : STARTER_FILES;
  } catch {
    return STARTER_FILES;
  }
}

function isDaniFreeInstance(instance: InstanceInfo) {
  return (
    instance.instanceId === "daniFree" ||
    /dani[- ]?free/i.test(instance.displayName) ||
    /dani[- ]?free/i.test(instance.driverKind)
  );
}

export function chooseGooeySelection(instances: InstanceInfo[]): ModelSelection | null {
  const available = instances.filter((instance) => instance.snapshot.state === "available");
  const instance = available.find(isDaniFreeInstance) ?? available[0];
  return instance ? { instanceId: instance.instanceId, model: instance.models.default } : null;
}

function modelOptionValue(instanceId: string, model: string) {
  return `${instanceId}::${encodeURIComponent(model)}`;
}

function messageText(message: Message) {
  if (message.kind === "text") return message.text?.trim();
  if (message.tool) return message.tool.spoken ?? `${message.tool.name} ${message.tool.ok === false ? "failed" : "ran"}`;
  return undefined;
}

export function IdeWorkspace() {
  const { state, dispatch, refreshInstances } = useStore();
  const stream = useStreaming();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>(readWorkspaceFiles);
  const [activePath, setActivePath] = useState("src/index.ts");
  const [draft, setDraft] = useState(() => readWorkspaceFiles().find((file) => file.path === "src/index.ts")?.content ?? "");
  const [prompt, setPrompt] = useState("");
  const [includeActiveFile, setIncludeActiveFile] = useState(true);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [turnRunning, setTurnRunning] = useState(false);
  const provisionedRef = useRef(false);

  const availableInstances = useMemo(
    () => state.instances.filter((instance) => instance.snapshot.state === "available"),
    [state.instances],
  );
  const preferredSelection = useMemo(
    () => chooseGooeySelection(availableInstances),
    [availableInstances],
  );
  const bot = selectedBotId ? state.bots.find((candidate) => candidate.id === selectedBotId) : undefined;
  const selectedInstance = bot
    ? state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)
    : undefined;
  const running = turnRunning || bot?.busy === true;
  const activeFile = files.find((file) => file.path === activePath) ?? files[0];
  const transcript = bot ? visibleMessages(bot) : [];
  const settledMessages = transcript.filter((message) => message.kind === "text" || message.tool);
  const streamText = bot ? stream.streaming[bot.threadId] ?? "" : "";
  const activityMessages = settledMessages.filter((message) => message.tool).slice(-4).reverse();

  useEffect(() => {
    if (!bot || bot.busy === false) setTurnRunning(false);
  }, [bot?.busy, bot?.id]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
    } catch {
      // The workspace remains usable when storage is unavailable.
    }
  }, [files]);

  useEffect(() => {
    if (!activeFile) return;
    setActivePath(activeFile.path);
    setDraft(activeFile.content);
  }, [activeFile]);

  useEffect(() => {
    if (provisionedRef.current || selectedBotId || !state.connected || availableInstances.length === 0) return;
    provisionedRef.current = true;
    setIsProvisioning(true);
    setProvisionError(null);

    const existing = state.bots.find((candidate) => candidate.name === ENGINEER_NAME);
    const existingIsAvailable =
      existing &&
      availableInstances.some((instance) => instance.instanceId === existing.modelSelection.instanceId);

    const useExisting = () => {
      if (!existingIsAvailable) return provisionBot();
      setSelectedBotId(existing.id);
      dispatch({ type: "select", id: existing.id });
      setIsProvisioning(false);
    };

    const provisionBot = async () => {
      if (!preferredSelection) {
        provisionedRef.current = false;
        setIsProvisioning(false);
        setProvisionError("No available model is connected to OMP.");
        return;
      }
      try {
        const { bot: created } = await api("/api/bots", {
          method: "POST",
          body: JSON.stringify({
            name: ENGINEER_NAME,
            title: ENGINEER_NAME,
            description: "Coding agent for the Gooey pi workspace.",
            section: "Gooey pi",
            requireAvailableModel: true,
            modelSelection: preferredSelection,
          }),
        });
        setSelectedBotId(created.id);
        dispatch({ type: "botAdded", bot: created });
        dispatch({ type: "select", id: created.id });
      } catch (error) {
        provisionedRef.current = false;
        setProvisionError(error instanceof Error ? error.message : "Could not start Gooey Engineer.");
      } finally {
        setIsProvisioning(false);
      }
    };

    useExisting();
  }, [availableInstances, dispatch, preferredSelection, selectedBotId, state.bots, state.connected]);

  const saveActiveFile = useCallback(() => {
    if (!activeFile) return;
    setIsSaving(true);
    window.setTimeout(() => {
      setFiles((current) => current.map((file) => (file.path === activeFile.path ? { ...file, content: draft } : file)));
      setIsSaving(false);
    }, 0);
  }, [activeFile, draft]);

  const switchModel = useCallback(
    async (value: string) => {
      if (!bot || bot.busy) return;
      const separator = value.indexOf("::");
      const instanceId = value.slice(0, separator);
      const model = decodeURIComponent(value.slice(separator + 2));
      setModelError(null);
      try {
        const { bot: updated } = await api(`/api/bots/${encodeURIComponent(bot.id)}/model`, {
          method: "PATCH",
          body: JSON.stringify({
            instanceId,
            model,
            ...(bot.modelSelection.effort ? { effort: bot.modelSelection.effort } : {}),
          }),
        });
        dispatch({ type: "botPatched", bot: updated });
      } catch (error) {
        setModelError(error instanceof Error ? error.message : "Could not switch models.");
      }
    },
    [bot, dispatch],
  );

  const sendPrompt = useCallback(() => {
    if (!bot || bot.busy || turnRunning || !prompt.trim()) return;
    const request = prompt.trim();
    const context =
      includeActiveFile && activeFile
        ? `\n\nActive file: ${activeFile.path}\n\`\`\`\n${draft}\n\`\`\``
        : "";
    setPrompt("");
    setTurnRunning(true);
    dispatch({
      type: "send",
      botId: bot.id,
      threadId: bot.threadId,
      text: `You are the coding agent for Gooey pi. Work through the OMP runtime and use its tools for repository changes.\n\n${request}${context}`,
    });
  }, [activeFile, bot, dispatch, draft, includeActiveFile, prompt, turnRunning]);

  const interrupt = useCallback(() => {
    if (!bot || !running) return;
    dispatch({ type: "interrupt", botId: bot.id, threadId: bot.threadId });
  }, [bot, dispatch, running]);

  const modelOptions = useMemo(() => {
    if (!selectedInstance) return [];
    const entries = [
      { id: selectedInstance.models.default, label: `Default · ${selectedInstance.models.default}` },
      ...selectedInstance.models.options.map((option) => ({ id: option.id, label: option.label })),
    ];
    const seen = new Set<string>();
    return entries.filter((option) => {
      if (seen.has(option.id)) return false;
      seen.add(option.id);
      return true;
    });
  }, [selectedInstance]);

  const modelValue =
    bot && selectedInstance
      ? modelOptionValue(bot.modelSelection.instanceId, bot.modelSelection.model)
      : preferredSelection
        ? modelOptionValue(preferredSelection.instanceId, preferredSelection.model)
        : "";

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-[#0b0f14] text-[#e6edf3]">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-white/10 bg-[#0d1117] px-4">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-cyan-300/10 text-cyan-300">
            <Code2 size={16} />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Gooey pi</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/70">Coding workspace</div>
          </div>
        </div>
        <div className="ml-3 flex items-center gap-1.5 text-xs text-slate-400">
          <GitBranch size={13} />
          <span>gooey-pi</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-[10px] font-medium text-emerald-300">
            OMP runtime
          </span>
          <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-1 text-[10px] font-medium text-cyan-300">
            {selectedInstance?.displayName ?? "Dani-Free"}
          </span>
          <button
            type="button"
            onClick={() => void refreshInstances()}
            aria-label="Refresh OMP instances"
            className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-ink"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[220px] shrink-0 flex-col border-r border-white/10 bg-[#0d1117]">
          <div className="flex items-center justify-between px-3 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Gooey workspace</div>
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">{files.length} files</span>
          </div>
          <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3" aria-label="Project files">
            {files.map((file) => {
              const depth = file.path.split("/").length - 1;
              const active = file.path === activeFile?.path;
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => {
                    setActivePath(file.path);
                    setDraft(file.content);
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                    active ? "bg-cyan-300/10 text-cyan-100" : "text-slate-300 hover:bg-white/5"
                  }`}
                  style={{ paddingLeft: `${8 + depth * 10}px` }}
                >
                  <FileCode2 size={13} className={active ? "text-cyan-300" : "text-slate-500"} />
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  {active && <ChevronRight size={12} className="text-cyan-300" />}
                </button>
              );
            })}
          </nav>
          <div className="border-t border-white/10 p-3 text-[11px] leading-relaxed text-slate-500">
            <div className="flex items-center gap-1.5 text-slate-400">
              <TerminalSquare size={13} />
              Local drafts
            </div>
            <p className="mt-1.5">Files are kept in this browser. Gooey Engineer can inspect the active file when you send a prompt.</p>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-[#0b0f14]">
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 bg-[#0d1117] px-2">
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => {
                  setActivePath(file.path);
                  setDraft(file.content);
                }}
                className={`flex h-full max-w-[180px] items-center gap-1.5 border-r border-white/10 px-3 text-xs whitespace-nowrap ${
                  file.path === activeFile?.path ? "border-b-2 border-b-cyan-300 text-cyan-100" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                <FileCode2 size={12} />
                <span className="truncate">{file.path.split("/").at(-1)}</span>
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2 px-2 text-[11px] text-slate-500">
              <span>{activeFile?.path}</span>
              <button
                type="button"
                onClick={saveActiveFile}
                disabled={isSaving}
                className="rounded-md border border-white/10 px-2 py-1 text-slate-300 hover:border-cyan-300/40 hover:text-cyan-200 disabled:opacity-50"
              >
                {isSaving ? "Saving…" : "Save local draft"}
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            <div className="flex w-11 shrink-0 select-none flex-col items-end gap-1 overflow-hidden border-r border-white/10 bg-[#0d1117] px-2 py-3 text-right text-[11px] leading-5 text-slate-600">
              {Array.from({ length: Math.max(1, draft.split("\n").length) }, (_, index) => (
                <span key={index}>{index + 1}</span>
              ))}
            </div>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              aria-label={`Editor for ${activeFile?.path ?? "active file"}`}
              className="min-h-0 w-full flex-1 resize-none bg-[#0b0f14] p-4 font-mono text-[12.5px] leading-6 text-slate-100 outline-none"
            />
          </div>

          <footer className="flex h-8 shrink-0 items-center justify-between border-t border-white/10 bg-[#0d1117] px-3 text-[11px] text-slate-500">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 size={12} className="text-emerald-300" />
              Workspace ready
            </span>
            <span>{draft.length.toLocaleString()} characters</span>
          </footer>
        </main>

        <aside className="flex w-[390px] shrink-0 flex-col border-l border-white/10 bg-[#0d1117]">
          <div className="border-b border-white/10 p-3">
            <div className="flex items-start gap-2.5">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-cyan-300/10 text-cyan-300">
                <Bot size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-sm font-semibold">Gooey Engineer</h1>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                      running ? "bg-amber-300/10 text-amber-300" : "bg-emerald-300/10 text-emerald-300"
                    }`}
                  >
                    {running ? "Running" : "Ready"}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-slate-500">
                  OMP owns tools, approvals, sessions, and state.
                </p>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <select
                value={modelValue}
                onChange={(event) => void switchModel(event.target.value)}
                disabled={!bot || running || modelOptions.length === 0}
                aria-label="Inference instance and model"
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-[#0b0f14] px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-300/50 disabled:opacity-50"
              >
                {modelOptions.map((option) => (
                  <option key={option.id} value={modelOptionValue(selectedInstance!.instanceId, option.id)}>
                    {selectedInstance?.displayName}: {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void refreshInstances()}
                aria-label="Refresh models"
                className="rounded-md border border-white/10 p-1.5 text-slate-400 hover:border-cyan-300/40 hover:text-cyan-200"
              >
                <RefreshCw size={14} />
              </button>
            </div>
            {modelError && (
              <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-300">
                <CircleAlert size={13} className="mt-px shrink-0" />
                <span>{modelError}</span>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
            {!state.connected && (
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs text-slate-400">
                <Loader2 size={14} className="animate-spin text-cyan-300" />
                Connecting to the OMP harness…
              </div>
            )}
            {state.connected && availableInstances.length === 0 && !isProvisioning && (
              <div className="rounded-lg border border-amber-300/20 bg-amber-300/[0.06] p-3 text-xs leading-relaxed text-amber-200">
                No available inference instance is connected. Start the Dani-Free proxy or refresh OMP instances.
              </div>
            )}
            {isProvisioning && (
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs text-slate-400">
                <Loader2 size={14} className="animate-spin text-cyan-300" />
                Starting Gooey Engineer…
              </div>
            )}
            {provisionError && (
              <div className="rounded-lg border border-red-300/20 bg-red-300/[0.06] p-3 text-xs leading-relaxed text-red-200">
                {provisionError}
              </div>
            )}
            {bot && settledMessages.length === 0 && !streamText && (
              <div className="rounded-lg border border-dashed border-white/15 p-4 text-center text-xs leading-relaxed text-slate-500">
                Ask Gooey Engineer to inspect the active file, plan a change, or implement a feature.
              </div>
            )}
            {settledMessages.map((message) => {
              const text = messageText(message);
              if (!text) return null;
              const fromBot = message.role === "bot";
              return (
                <div key={message.id} className={`mb-3 rounded-lg border p-3 text-xs leading-relaxed ${
                  fromBot ? "border-cyan-300/15 bg-cyan-300/[0.04]" : "border-white/10 bg-white/[0.03]"
                }`}>
                  <div className={`mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                    fromBot ? "text-cyan-300" : "text-slate-400"
                  }`}>
                    {fromBot ? "Gooey Engineer" : "You"}
                  </div>
                  <div className={`whitespace-pre-wrap ${fromBot ? "text-slate-200" : "text-slate-100"}`}>{text}</div>
                </div>
              );
            })}
            {streamText && (
              <div className="mb-3 rounded-lg border border-cyan-300/30 bg-cyan-300/[0.06] p-3 text-xs leading-relaxed text-slate-100">
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan-300">
                  <Loader2 size={12} className="animate-spin" />
                  Streaming
                </div>
                <div className="whitespace-pre-wrap">{streamText}</div>
              </div>
            )}
          </div>

          {activityMessages.length > 0 && (
            <div className="max-h-28 shrink-0 overflow-y-auto border-t border-white/10 bg-[#0b0f14] px-3 py-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                <TerminalSquare size={12} />
                OMP activity
              </div>
              {activityMessages.map((message) => (
                <div key={message.id} className="truncate text-[11px] text-slate-500">
                  {messageText(message)}
                </div>
              ))}
            </div>
          )}

          <div className="shrink-0 border-t border-white/10 bg-[#0d1117] p-3">
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
              <input
                type="checkbox"
                checked={includeActiveFile}
                onChange={(event) => setIncludeActiveFile(event.target.checked)}
                className="rounded border-white/20 bg-[#0b0f14] text-cyan-300"
              />
              Include active file in context
            </label>
            <div className="mt-2 rounded-lg border border-white/10 bg-[#0b0f14] p-2 focus-within:border-cyan-300/50">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendPrompt();
                }}
                placeholder="Ask Gooey Engineer to change something…"
                aria-label="Coding prompt"
                className="h-20 w-full resize-none bg-transparent text-xs leading-5 text-slate-100 outline-none placeholder:text-slate-600"
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="truncate text-[10px] text-slate-600">
                {activeFile ? `Context: ${activeFile.path}` : "No active file"}
              </span>
              {running ? (
                <button
                  type="button"
                  onClick={interrupt}
                  className="flex items-center gap-1.5 rounded-md bg-red-300/10 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-300/20"
                >
                  <Square size={12} />
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={sendPrompt}
                  disabled={!bot || !prompt.trim()}
                  className="flex items-center gap-1.5 rounded-md bg-cyan-300 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Play size={12} fill="currentColor" />
                  Run agent
                </button>
              )}
            </div>
            <div className="mt-2 text-[10px] text-slate-600">⌘/Ctrl + Enter to send · model inference stays with Dani-Free</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
