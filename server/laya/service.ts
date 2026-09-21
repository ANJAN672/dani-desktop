/**
 * LayaDecisionService - the real DecisionProvider behind spec 100 R2/R3/R4.
 *
 * One resident Python sidecar owns one pinned checkpoint. This class owns
 * lifecycle (lazy spawn, idle unload, crash restart), the consented install
 * flow, request/response contract validation, and the abstention policy.
 * It returns scores only. It cannot authorize, dispatch, retry, or execute
 * anything; callers (shadow logger, router) keep Hermes authoritative.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_DECISION_TIMEOUT_MS,
  NONE_OF_THE_ABOVE,
  LAYA_DECISION_SCHEMA_ID,
  LAYA_DECISION_SCHEMA_VERSION,
  topScoringOption,
  validateDecisionRequest,
  validateScores,
  type LayaDecision,
  type LayaDecisionRequest,
  type LayaDecisionResult,
  type LayaFailureKind,
} from "./contract.ts";
import { LAYA_SDK, LAYA_TYPED_DECISIONS, type LayaCheckpointPin } from "./manifest.ts";

const SIDECAR_PATH = join(dirname(fileURLToPath(import.meta.url)), "sidecar", "laya_sidecar.py");
const DEFAULT_LOAD_TIMEOUT_MS = 300_000;
const DEFAULT_IDLE_UNLOAD_MS = 15 * 60_000;
// Starting point only: on 2026-09-22 the real checkpoint (vendor-hosted demo,
// routing schema) scored a clear case at confidence 0.085 and garbage input at
// 0.005. Re-derive from shadow-ledger calibration before route execution opens.
const DEFAULT_MIN_CONFIDENCE = 0.02;
const DEFAULT_MIN_ACT_PROBABILITY = 0.5;

export interface LayaServiceOptions {
  checkpoint?: LayaCheckpointPin;
  /** Durable app-data directory: python venv, HF cache, install marker. */
  cacheDir: string;
  pythonPath?: string;
  device?: "auto" | "cpu" | "cuda";
  minConfidence?: number;
  minActProbability?: number;
  loadTimeoutMs?: number;
  idleUnloadMs?: number;
  logger?: (line: string) => void;
}

export interface LayaInstallState {
  subfolder: string;
  revision: string;
  weightsSha256: string;
  verifiedAt: string;
  sdkVersion: string;
}

export type LayaSidecarState = "stopped" | "starting" | "loading" | "ready" | "crashed";

export interface LayaServiceStatus {
  installed: boolean;
  install: LayaInstallState | null;
  requiredDownloadBytes: number;
  sidecar: LayaSidecarState;
  loadedIdentity: { repo: string; subfolder: string; revision: string } | null;
}

interface PendingCall {
  id: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onTimeout: () => void;
}

type SidecarErrorKind = "NOT_LOADED" | "SDK_UNAVAILABLE" | "HASH_MISMATCH" | "BAD_METHOD" | "SIDECAR_ERROR";

const failure = (kind: LayaFailureKind, message: string, started: number): LayaDecisionResult => ({
  ok: false,
  failure: kind,
  message,
  elapsedMs: Date.now() - started,
});

export class LayaDecisionService {
  private readonly checkpoint: LayaCheckpointPin;
  private readonly cacheDir: string;
  private readonly device?: "cpu" | "cuda";
  private readonly minConfidence: number;
  private readonly minActProbability: number;
  private readonly loadTimeoutMs: number;
  private readonly idleUnloadMs: number;
  private readonly logger: (line: string) => void;

  private pythonPath: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: LayaSidecarState = "stopped";
  private loadedIdentity: { repo: string; subfolder: string; revision: string } | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(options: LayaServiceOptions) {
    this.checkpoint = options.checkpoint ?? LAYA_TYPED_DECISIONS;
    this.cacheDir = options.cacheDir;
    this.device = options.device === "auto" || options.device === undefined ? undefined : options.device;
    this.minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.minActProbability = options.minActProbability ?? DEFAULT_MIN_ACT_PROBABILITY;
    this.loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    this.idleUnloadMs = options.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS;
    this.logger = options.logger ?? (() => undefined);
    this.pythonPath = options.pythonPath ?? "python3";
  }

  private get markerPath(): string {
    return join(this.cacheDir, `laya-installed-${this.checkpoint.subfolder || "english"}.json`);
  }

  installState(): LayaInstallState | null {
    try {
      const raw = JSON.parse(readFileSync(this.markerPath, "utf8")) as LayaInstallState;
      const weights = this.checkpoint.files.find((f) => f.path.endsWith("model.safetensors"));
      if (
        raw.subfolder === this.checkpoint.subfolder &&
        raw.revision === this.checkpoint.revision &&
        raw.weightsSha256 === weights?.sha256 &&
        raw.sdkVersion === LAYA_SDK.version
      )
        return raw;
      return null; // stale pin: a re-pin requires a fresh verified download
    } catch {
      return null;
    }
  }

  status(): LayaServiceStatus {
    const install = this.installState();
    return {
      installed: install !== null,
      install,
      requiredDownloadBytes: this.checkpoint.downloadBytes,
      sidecar: this.state,
      loadedIdentity: this.loadedIdentity,
    };
  }

  /**
   * Consented install: build an isolated venv, pip-install the pinned SDK,
   * download the pinned checkpoint files and verify LFS sha256. Long-running;
   * reports progress through the logger. Writes the install marker only after
   * every pinned file verifies.
   */
  async install(): Promise<{ verified: string[] }> {
    if (this.closed) throw new Error("LayaDecisionService is closed");
    const venvPython = join(this.cacheDir, "venv", "bin", "python");
    mkdirSync(this.cacheDir, { recursive: true });
    if (!existsSync(venvPython)) {
      this.logger(`laya: creating python venv in ${this.cacheDir}`);
      const venv = spawnSync(this.pythonPath, ["-m", "venv", join(this.cacheDir, "venv")], { encoding: "utf8" });
      if (venv.status !== 0) throw new Error(`python venv creation failed: ${venv.stderr || venv.stdout}`);
    }
    this.logger(`laya: installing SDK ${LAYA_SDK.package}==${LAYA_SDK.version}`);
    const pip = spawnSync(
      venvPython,
      ["-m", "pip", "install", "--quiet", `${LAYA_SDK.package}==${LAYA_SDK.version}`],
      { encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 16 << 20 },
    );
    if (pip.status !== 0) throw new Error(`pip install ${LAYA_SDK.package} failed: ${pip.stderr || pip.stdout}`);
    this.pythonPath = venvPython;

    await this.spawnSidecar();
    const result = (await this.call(
      "download",
      {
        repo: this.checkpoint.repo,
        revision: this.checkpoint.revision,
        cache_dir: join(this.cacheDir, "hf"),
        files: this.checkpoint.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
      },
      this.loadTimeoutMs,
    )) as { verified: Array<{ path: string }> };
    const weights = this.checkpoint.files.find((f) => f.path.endsWith("model.safetensors"));
    const marker: LayaInstallState = {
      subfolder: this.checkpoint.subfolder,
      revision: this.checkpoint.revision,
      weightsSha256: weights?.sha256 ?? "",
      verifiedAt: new Date().toISOString(),
      sdkVersion: LAYA_SDK.version,
    };
    writeFileSync(this.markerPath, JSON.stringify(marker, null, 2));
    this.logger(`laya: checkpoint ${this.checkpoint.subfolder || "english"} installed and hash-verified`);
    return { verified: result.verified.map((v) => v.path) };
  }

  /** Score one bounded decision. Never throws: every outcome is typed. */
  async decide(req: LayaDecisionRequest): Promise<LayaDecisionResult> {
    const started = Date.now();
    if (this.closed) return failure("UNAVAILABLE", "service is closed", started);
    const problem = validateDecisionRequest(req);
    if (problem) return failure(problem === "deadline already passed" ? "STALE_DEADLINE" : "INVALID_REQUEST", problem, started);
    const labels = new Set<string>();
    for (const option of req.options) {
      if (labels.has(option.label))
        return failure("INVALID_REQUEST", `duplicate option label ${JSON.stringify(option.label)}`, started);
      labels.add(option.label);
    }
    if (!this.installState())
      return failure(
        "NOT_INSTALLED",
        `checkpoint ${this.checkpoint.subfolder || "english"} not installed; requires ${this.checkpoint.downloadBytes} bytes download`,
        started,
      );
    const timeoutMs = req.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
      } catch (error) {
        return failure("UNAVAILABLE", error instanceof Error ? error.message : String(error), started);
      }
      const criteria: Record<string, string> = {};
      for (const option of req.options) criteria[option.label] = option.description ?? option.label;
      criteria[NONE_OF_THE_ABOVE] = "none of the listed options fits; the correct action is not enumerated";
      let raw: unknown;
      try {
        const response = await this.call(
          "predict",
          {
            state: { task: req.objective, context: req.stateSummary },
            questions: {
              decision: { type: "choice", instructions: req.objective, criteria },
            },
          },
          timeoutMs,
        );
        raw = (response as { raw: unknown }).raw;
      } catch (error) {
        const kind = (error as Error & { layaKind?: string }).layaKind;
        if (kind === "TIMEOUT") return failure("TIMEOUT", `decision exceeded ${timeoutMs}ms`, started);
        return failure("SIDECAR_ERROR", error instanceof Error ? error.message : String(error), started);
      }
      return this.mapDecision(raw, req, started);
    });
  }

  private mapDecision(raw: unknown, req: LayaDecisionRequest, started: number): LayaDecisionResult {
    const answer = (raw as { answers?: Record<string, unknown> } | null)?.answers?.decision as
      | { probabilities?: Record<string, number>; confidence?: number; rl_agent?: { act_probability?: number } }
      | undefined;
    if (!answer || typeof answer !== "object") return failure("INVALID_RESPONSE", "sidecar returned no decision answer", started);
    const byLabel = answer.probabilities;
    if (!byLabel || typeof byLabel !== "object")
      return failure("INVALID_RESPONSE", "decision answer carries no probabilities", started);
    const byId: Record<string, number> = {};
    for (const option of req.options) {
      const value = byLabel[option.label];
      if (value !== undefined) byId[option.id] = value;
    }
    if (byLabel[NONE_OF_THE_ABOVE] !== undefined) byId[NONE_OF_THE_ABOVE] = byLabel[NONE_OF_THE_ABOVE];
    const validated = validateScores(byId, req.options);
    if ("problem" in validated) return failure("INVALID_RESPONSE", validated.problem, started);
    const confidence = typeof answer.confidence === "number" ? answer.confidence : 0;
    const actProbability =
      typeof answer.rl_agent?.act_probability === "number" ? answer.rl_agent.act_probability : 0;
    const top = topScoringOption(validated.scores);
    const weights = this.checkpoint.files.find((f) => f.path.endsWith("model.safetensors"));
    let abstained = false;
    let abstainReason: string | null = null;
    if (top.optionId === null) {
      abstained = true;
      abstainReason = "model selected NONE_OF_THE_ABOVE";
    } else if (actProbability < this.minActProbability) {
      abstained = true;
      abstainReason = `act probability ${actProbability} below threshold ${this.minActProbability}`;
    } else if (confidence < this.minConfidence) {
      abstained = true;
      abstainReason = `confidence ${confidence} below threshold ${this.minConfidence}`;
    }
    const decision: LayaDecision = {
      schemaId: LAYA_DECISION_SCHEMA_ID,
      schemaVersion: LAYA_DECISION_SCHEMA_VERSION,
      checkpoint: {
        repo: this.checkpoint.repo,
        subfolder: this.checkpoint.subfolder,
        revision: this.checkpoint.revision,
        weightsSha256: weights?.sha256 ?? "",
      },
      scores: validated.scores,
      selectedOptionId: abstained ? null : top.optionId,
      confidence,
      actProbability,
      abstained,
      abstainReason,
      elapsedMs: Date.now() - started,
    };
    return { ok: true, decision };
  }

  /** Serialize all sidecar interaction: one model, one in-flight call. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state === "ready") {
      this.scheduleIdleUnload();
      return;
    }
    const snapshotDir = join(
      this.cacheDir,
      "hf",
      `models--${this.checkpoint.repo.replace("/", "--")}`,
      "snapshots",
      this.checkpoint.revision,
    );
    if (!existsSync(snapshotDir))
      throw new Error(`pinned checkpoint snapshot missing at ${snapshotDir}; run the consented install first`);
    await this.spawnSidecar();
    this.state = "loading";
    const identity = (await this.call(
      "load",
      {
        model_dir: snapshotDir,
        subfolder: this.checkpoint.subfolder || undefined,
        device: this.device,
        identity: { repo: this.checkpoint.repo, revision: this.checkpoint.revision },
      },
      this.loadTimeoutMs,
    )) as { repo: string; subfolder: string; revision: string };
    this.loadedIdentity = identity;
    this.state = "ready";
    this.scheduleIdleUnload();
  }

  private scheduleIdleUnload(): void {
    if (this.idleUnloadMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.enqueue(async () => {
        if (this.state === "ready") await this.unload();
      });
    }, this.idleUnloadMs);
    if (typeof this.idleTimer === "object" && "unref" in this.idleTimer) this.idleTimer.unref();
  }

  async unload(): Promise<void> {
    if (this.state === "ready" || this.state === "loading") {
      try {
        await this.call("unload", {}, 10_000);
      } catch {
        /* unload failure is handled by stopping the process below */
      }
    }
    this.loadedIdentity = null;
    this.stopChild();
    this.state = "stopped";
  }

  private spawnSidecar(): Promise<void> {
    if (this.child && (this.state === "starting" || this.state === "loading" || this.state === "ready"))
      return Promise.resolve();
    if (this.closed) return Promise.reject(new Error("service is closed"));
    this.stopChild();
    this.state = "starting";
    this.logger(`laya: spawning sidecar (${this.pythonPath} ${SIDECAR_PATH})`);
    const child = spawn(this.pythonPath, [SIDECAR_PATH], {
      env: { ...process.env, USE_TF: "0", HF_HOME: join(this.cacheDir, "hf") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) this.logger(`laya sidecar: ${line}`);
      }
    });
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let msg: { id?: string; ok?: boolean; result?: unknown; error?: { kind?: string; message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        this.logger(`laya sidecar protocol violation: ${line.slice(0, 200)}`);
        return;
      }
      const call = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!call) return;
      this.pending.delete(call.id);
      clearTimeout(call.timer);
      if (msg.ok) call.resolve(msg.result);
      else {
        const kind: SidecarErrorKind = (msg.error?.kind as SidecarErrorKind) ?? "SIDECAR_ERROR";
        const error = new Error(msg.error?.message ?? "sidecar error") as Error & { layaKind?: string };
        error.layaKind = kind;
        call.reject(error);
      }
    });
    child.on("exit", (code) => {
      this.logger(`laya sidecar exited with code ${code}`);
      if (this.state !== "stopped") this.state = "crashed";
      this.loadedIdentity = null;
      this.child = null;
      for (const call of this.pending.values()) {
        clearTimeout(call.timer);
        const error = new Error(`sidecar exited with code ${code}`) as Error & { layaKind?: string };
        error.layaKind = "UNAVAILABLE";
        call.reject(error);
      }
      this.pending.clear();
    });
    return Promise.resolve();
  }

  private call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("sidecar is not running"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A stuck model must not poison later calls: restart the sidecar.
        this.unload().catch(() => undefined);
        const error = new Error(`sidecar ${method} timed out after ${timeoutMs}ms`) as Error & { layaKind?: string };
        error.layaKind = "TIMEOUT";
        reject(error);
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      this.pending.set(id, { id, resolve, reject, timer, onTimeout: () => undefined });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private stopChild(): void {
    if (this.child) {
      this.child.removeAllListeners("exit");
      this.child.kill("SIGKILL");
      this.child = null;
    }
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("sidecar stopped"));
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.unload().catch(() => undefined);
    this.state = "stopped";
  }
}
