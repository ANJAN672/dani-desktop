/**
 * BoxProxyCuaDriver - binds the bounded CUA controller (spec 100 R7) to a
 * bot's real cloud box by driving the EXISTING computer proxy
 * (server/computer-proxy.ts) as a child MCP stdio server.
 *
 * Nothing here reimplements execution: every action goes through the proxy's
 * own guarded tool surface, so the who-is-driving lease (CONTROL_REFUSAL),
 * the act+observe evidence frames, the stale-ref rules, and the box wake
 * logic all apply exactly as they do for a Hermes-driven turn. This driver
 * only translates between CuaDriver and newline-delimited JSON-RPC.
 *
 * One child process per driver instance, reused across steps: the proxy's
 * semantic browser refs live in the process, so snapshot and the click that
 * follows it must share one process. Close the driver when the run ends.
 *
 * UNVERIFIED on hardware: exercised against the real proxy process with a
 * stub box API in tests; no real box has been driven.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { computerProxyEnv } from "../container-computer.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { CONTROL_REFUSAL } from "../control-client.ts";
import type { CuaCandidateAction, CuaDriver, CuaStateSnapshot, CuaToolCall } from "./cua-controller.ts";

export interface BoxComputerIntegration {
  kind: "box";
  boxId: string;
  token: string;
  control?: { url: string; token: string };
}

export class CuaLeaseRefused extends Error {
  constructor() {
    super("the person is driving this computer right now");
    this.name = "CuaLeaseRefused";
  }
}

const SNAPSHOT_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 130_000;
const MAX_CANDIDATES = 11; // the decision contract allows 12 including NONE_OF_THE_ABOVE

interface PendingRpc {
  resolve: (result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BoxProxyCuaDriver implements CuaDriver {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly computer: BoxComputerIntegration;
  private readonly logger: (line: string) => void;
  private readonly pending = new Map<string, PendingRpc>();
  private closed = false;

  constructor(computer: BoxComputerIntegration, logger: (line: string) => void = () => undefined) {
    this.computer = computer;
    this.logger = logger;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.closed) throw new Error("driver is closed");
    if (this.child) return this.child;
    const child = spawn(process.execPath, [SPAWNED_PROXIES.computer], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(this.computer) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) this.logger(`computer-proxy: ${line.slice(0, 300)}`);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let parsed: { id?: string; result?: { content: Array<{ type: string; text?: string }>; isError?: boolean }; error?: { message?: string } };
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // the proxy ignores malformed lines; so do we
      }
      if (parsed.id === undefined) return;
      const id = parsed.id;
      const call = this.pending.get(id);
      if (!call) return;
      this.pending.delete(id);
      clearTimeout(call.timer);
      if (parsed.error) call.reject(new Error(parsed.error.message ?? "proxy error"));
      else call.resolve(parsed.result!);
    });
    child.on("exit", (code) => {
      this.child = null;
      for (const [id, call] of this.pending) {
        this.pending.delete(id);
        clearTimeout(call.timer);
        call.reject(new Error(`computer proxy exited with code ${code}`));
      }
    });
    return child;
  }

  private rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const child = this.ensureChild();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`computer proxy ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        reject,
        resolve: (result) => {
          const text = result?.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") ?? "";
          if (result?.isError) {
            if (text === CONTROL_REFUSAL) reject(new CuaLeaseRefused());
            else reject(new Error(text || "computer tool failed"));
          } else resolve(text);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Parse `- [ref] role: name` lines from the proxy's semantic snapshot. */
  static candidatesFromSnapshot(text: string): CuaCandidateAction[] {
    const candidates: CuaCandidateAction[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^- \[(.+?)\] (\w[\w-]*)( disabled)?: (.*)$/);
      if (!m || m[3]) continue; // disabled elements are not actionable
      candidates.push({
        id: m[1],
        label: `${m[2]}: ${m[4]}`.slice(0, 160),
        description: `clickable ${m[2]} element in the current browser page`,
        tool: { name: "browser_click", args: { ref: m[1] } },
      });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    return candidates;
  }

  async observe(_botId: string): Promise<CuaStateSnapshot> {
    let text: string;
    try {
      text = await this.rpc("tools/call", { name: "browser_snapshot", arguments: {} }, SNAPSHOT_TIMEOUT_MS);
    } catch (error) {
      // A lease refusal is not an empty state: the person is driving.
      if (error instanceof CuaLeaseRefused) throw error;
      // No semantic browser state is an honest empty state, not a crash:
      // the controller aborts no_candidates and Hermes takes over.
      return {
        summary: `semantic browser state unavailable: ${error instanceof Error ? error.message : String(error)}`,
        candidates: [],
        stateVersion: "unavailable",
      };
    }
    return {
      summary: text,
      candidates: BoxProxyCuaDriver.candidatesFromSnapshot(text),
      stateVersion: createHash("sha256").update(text).digest("hex").slice(0, 16),
    };
  }

  async act(_botId: string, tool: CuaToolCall): Promise<{ evidence: string }> {
    const evidence = await this.rpc("tools/call", { name: tool.name, arguments: tool.args }, ACTION_TIMEOUT_MS);
    return { evidence };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.child) {
      this.child.kill("SIGKILL");
      this.child = null;
    }
  }
}
