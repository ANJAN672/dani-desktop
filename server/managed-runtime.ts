import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, readlink, readdir, rename, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import extractZip from "extract-zip";
import * as tar from "tar";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

export type ManagedRuntimeKind = "hermes" | "opencode";
export const MANAGED_OPENCODE_PROMPT_TIMEOUT_MS = 300_000;
export type RuntimeBootstrapStatus = {
  schemaVersion: 1;
  state: "checking" | "installing" | "ready" | "repairable-error" | "blocked-error";
  phase: "detect" | "verify-bundled" | "activate" | "probe" | null;
  progress: { completedBytes: number; totalBytes: number } | null;
  runtime: { kind: "hermes"; version: string | null; source: "bundled" | "managed" | "external" | null };
  readiness: {
    runtime: { state: "checking" | "ready" | "error"; hermes: boolean; opencode: boolean };
    modelRoute: { state: "checking" | "ready" | "error" };
    taskReady: boolean;
    activeRuntime: ManagedRuntimeKind | null;
  };
  canRetry: boolean;
  canContinueLimited: boolean;
  error: { code: string; message: string } | null;
};

export function managedRuntimeReadiness(input: { hermes: boolean; opencode: boolean; modelRoute: "checking" | "ready" | "error" }) {
  const runtimeReady = input.hermes && input.opencode;
  const taskReady = runtimeReady && input.modelRoute === "ready";
  return { runtime: { state: runtimeReady ? "ready" as const : "error" as const, hermes: input.hermes, opencode: input.opencode }, modelRoute: { state: input.modelRoute }, taskReady };
}
const targetSchema = z.enum(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"]);
const runtimeSchema = z.object({
  name: z.enum(["hermes-runtime-payload", "opencode-runtime-payload"]),
  target: targetSchema,
  version: z.string().min(1),
  upstreamCommit: z.string().regex(/^[a-f0-9]{40}$/),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  archiveSize: z.number().int().positive(),
  unpackedSize: z.number().int().positive(),
  format: z.enum(["tar.gz", "zip"]),
  executableRelPath: z.string().min(1),
  probe: z.object({
    argv: z.array(z.string()).min(1),
    protocol: z.string().startsWith("acp-jsonrpc-stdio"),
    expectedVersion: z.string().min(1),
    expectedAgentName: z.string().min(1),
  }),
  noticeRelPath: z.string().min(1),
  sbomRelPath: z.string().min(1),
  degradations: z.array(z.string().min(1)),
}).superRefine((entry, context) => {
  for (const [field, value] of [["executableRelPath", entry.executableRelPath], ["noticeRelPath", entry.noticeRelPath], ["sbomRelPath", entry.sbomRelPath]] as const) {
    try { safeManagedRuntimeRelativePath(value); }
    catch { context.addIssue({ code: "custom", message: "unsafe relative path", path: [field] }); }
  }
  if (entry.target === "darwin-x64" && entry.degradations.length === 0) {
    context.addIssue({ code: "custom", message: "darwin-x64 payloads require explicit degradations", path: ["degradations"] });
  }
  const probePath = entry.probe.argv[0]?.toLowerCase() ?? "";
  if (entry.target.startsWith("win32-") ? !probePath.endsWith(".cmd") : probePath.endsWith(".cmd")) {
    context.addIssue({ code: "custom", message: "probe launcher does not match target platform", path: ["probe", "argv", 0] });
  }
});
const manifestSchema = runtimeSchema.extend({ manifestVersion: z.literal(1) });
export function parseManagedRuntimeManifest(raw: unknown) { return manifestSchema.parse(raw); }
type RuntimeEntry = z.infer<typeof runtimeSchema>;

export const safeManagedRuntimeRelativePath = (value: string) => {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some(part => !part || part === "." || part === "..")) throw new Error("unsafe runtime manifest path");
  return normalized;
};
const safeJoin = (root: string, rel: string) => {
  const target = resolve(root, safeManagedRuntimeRelativePath(rel));
  const prefix = resolve(root) + sep;
  if (!target.startsWith(prefix)) throw new Error("runtime manifest path escapes its root");
  return target;
};
export const safeManagedRuntimeSymlinkTarget = (root: string, linkPath: string, linkTarget: string) => {
  if (!linkTarget || resolve(linkTarget) === linkTarget || /^[A-Za-z]:/.test(linkTarget)) throw new Error("runtime symlink target must be relative");
  const target = resolve(join(root, relative(root, linkPath)), "..", linkTarget);
  const normalizedRoot = resolve(root);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) throw new Error("runtime symlink target escapes its root");
  return target;
};
export const managedRuntimeTarget = (): z.infer<typeof targetSchema> => {
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const platform = process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
  return `${platform}-${architecture}`;
};
const archiveName = (entry: RuntimeEntry) => `${entry.name}-${entry.target}.${entry.format}`;
const payloadName = (kind: ManagedRuntimeKind) => `${kind}-runtime-payload` as const;
const digestFile = async (path: string) => {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try { for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk)); }
  finally { await handle.close().catch(() => undefined); }
  return hash.digest("hex");
};
const rejectUnsafeMode = (mode: number, path: string) => {
  if (process.platform !== "win32" && (mode & 0o022) !== 0) throw Object.assign(new Error(`unsafe permissions: ${path}`), { code: "verification-failed" });
};
async function inspectExtracted(root: string): Promise<number> {
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const rel = relative(root, path).replaceAll("\\", "/");
      safeManagedRuntimeRelativePath(rel);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        safeManagedRuntimeSymlinkTarget(root, path, await readlink(path));
        continue;
      }
      rejectUnsafeMode(info.mode, rel);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) bytes += info.size;
      else throw Object.assign(new Error("runtime archive contains an unsupported entry"), { code: "verification-failed" });
    }
  };
  await visit(root);
  return bytes;
}
async function digestTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path).replaceAll("\\", "/");
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        safeManagedRuntimeSymlinkTarget(root, path, target);
        hash.update(`${rel}\0symlink\0${target}\n`);
      } else if (info.isDirectory()) await visit(path);
      else if (info.isFile()) hash.update(`${rel}\0${info.size}\0${await digestFile(path)}\n`);
      else throw Object.assign(new Error("runtime activation contains an unsupported entry"), { code: "verification-failed" });
    }
  };
  await visit(root);
  return hash.digest("hex");
}
async function extractArchive(entry: RuntimeEntry, archive: string, staging: string): Promise<void> {
  const validatePath = (value: string) => { safeManagedRuntimeRelativePath(value.replace(/\/$/, "")); };
  if (entry.format === "zip") {
    await extractZip(archive, { dir: staging, onEntry: zipEntry => {
      validatePath(zipEntry.fileName);
      const mode = (zipEntry.externalFileAttributes >> 16) & 0xffff;
      if ((mode & 0o170000) !== 0o120000) rejectUnsafeMode(mode, zipEntry.fileName);
    } });
  } else {
    await tar.x({
      cwd: staging,
      file: archive,
      strict: true,
      preservePaths: false,
      // Payload archives have one signed top-level directory; manifests are
      // rooted inside it (bin/, probe/, NOTICE, SBOM).
      strip: 1,
      filter: (path, tarEntry) => {
        validatePath(path);
        const archiveEntry = tarEntry as { type?: string; mode?: number };
        if (archiveEntry.type === "Link") throw Object.assign(new Error("runtime archives may not contain hard links"), { code: "verification-failed" });
        if (archiveEntry.type === "SymbolicLink") {
          const linkPath = safeJoin(staging, path.replace(/\/$/, ""));
          safeManagedRuntimeSymlinkTarget(staging, linkPath, String((tarEntry as { linkpath?: string }).linkpath ?? ""));
        } else rejectUnsafeMode(archiveEntry.mode ?? 0, path);
        return true;
      },
    });
  }
  const unpacked = await inspectExtracted(staging);
  if (unpacked !== entry.unpackedSize) throw Object.assign(new Error("runtime unpacked size mismatch"), { code: "verification-failed" });
}
const safeError = (code: string, message: string) => ({ code, message });
const productMessage = (code: string) => ({
  "payload-missing": "Dani's bundled runtime is missing from this installation.",
  "manifest-invalid": "Dani's bundled runtime manifest is invalid.",
  "verification-failed": "Dani could not verify the bundled runtime.",
  "activation-failed": "Dani could not activate its local runtime.",
  "runtime-quarantined": "Dani's local runtime could not start. Security software may have quarantined it.",
  "probe-failed": "Dani's local runtime did not pass its readiness check.",
}[code] ?? "Dani could not prepare its local runtime.");

async function run(command: string, args: string[], timeoutMs: number, input?: string): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error("runtime probe timed out"), { code: "probe-failed" })); }, timeoutMs);
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("error", error => { clearTimeout(timer); reject(Object.assign(error, { code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "runtime-quarantined" : "probe-failed" })); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      else reject(Object.assign(new Error(`runtime probe exited ${code}`), { code: "probe-failed" }));
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}


async function freeLoopbackPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}
async function requireReady(url: string, timeoutMs: number) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json() as { ok?: unknown; model?: unknown; cost?: { input?: unknown; output?: unknown; cache?: { read?: unknown; write?: unknown } }; paidFallback?: unknown };
  if (!response.ok || body.ok !== true || body.model !== "opencode/big-pickle" || body.paidFallback !== false || body.cost?.input !== 0 || body.cost.output !== 0 || body.cost.cache?.read !== 0 || body.cost.cache.write !== 0) throw new Error("exact free model route is not ready");
}
async function waitForReady(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { await requireReady(url, 2_000); return; } catch { await new Promise(resolveWait => setTimeout(resolveWait, 250)); } }
  throw Object.assign(new Error("model route readiness timed out"), { code: "model-route-failed" });
}

export class ManagedRuntimeService {
  private readonly resourcesRoot: string;
  private readonly installRoot: string;
  private active: Partial<Record<ManagedRuntimeKind, string>> = {};
  private run: Partial<Record<ManagedRuntimeKind, Promise<void>>> = {};
  private bootstrapRun: Promise<void> | null = null;
  private modelRouteState: "checking" | "ready" | "error" = "checking";
  private activePhases: Partial<Record<ManagedRuntimeKind, RuntimeBootstrapStatus["phase"]>> = {};
  private bridge: ReturnType<typeof spawn> | null = null;
  private opencodeServer: ReturnType<typeof spawn> | null = null;
  private routeMonitor: ReturnType<typeof setInterval> | null = null;
  private bridgeUrl: string | null = null;
  private taskReadyHandler: (() => Promise<void>) | null = null;
  private status: RuntimeBootstrapStatus = this.statusValue("checking", "detect");
  constructor(options: { resourcesRoot: string; dataDir: string }) {
    this.resourcesRoot = join(options.resourcesRoot, "managed-runtimes");
    this.installRoot = join(options.dataDir, "managed-runtimes");
    this.recoverActive("hermes"); this.recoverActive("opencode");
  }
  async initialize() {
    const results = await Promise.allSettled([this.verifyRecovered("hermes"), this.verifyRecovered("opencode")]);
    if (results[0]?.status === "rejected") delete this.active.hermes;
    if (results[1]?.status === "rejected") delete this.active.opencode;
    if (results.every(result => result.status === "fulfilled")) this.refreshReadyStatus();
    else {
      const error = results.find(result => result.status === "rejected") as PromiseRejectedResult | undefined;
      const code = this.errorCode(error?.reason, "not-activated");
      this.status = this.statusValue("repairable-error", null, safeError(code, code === "not-activated" ? "Dani's local runtimes need to be prepared." : productMessage(code)));
    }
  }
  bootstrapStatus(): RuntimeBootstrapStatus { return structuredClone(this.status); }
  setTaskReadyHandler(handler: () => Promise<void>) { this.taskReadyHandler = handler; }
  executable(kind: ManagedRuntimeKind): string | null { return this.active[kind] ?? null; }
  useManagedExecutables() {
    if (this.active.hermes) process.env.DANI_MANAGED_HERMES_EXECUTABLE = this.active.hermes;
    if (this.active.opencode) process.env.DANI_MANAGED_OPENCODE_EXECUTABLE = this.active.opencode;
  }
  setModelRouteReadiness(state: "checking" | "ready" | "error") {
    this.modelRouteState = state;
    if (this.active.hermes && this.active.opencode) this.refreshReadyStatus();
  }
  async install(kind: ManagedRuntimeKind): Promise<void> {
    const current = this.run[kind];
    if (current) return current;
    const task = this.activate(kind).finally(() => { delete this.run[kind]; });
    this.run[kind] = task; return task;
  }
  startBootstrap(): RuntimeBootstrapStatus {
    if (!this.bootstrapRun) {
      this.status = this.statusValue("installing", "verify-bundled");
      this.bootstrapRun = Promise.all([this.install("hermes"), this.install("opencode")])
        .then(async () => {
          await this.startModelRoute();
          // Keep bootstrap non-ready until product state has adopted the managed
          // executable and exact model. Otherwise a fresh UI can dispatch its
          // quiz against the empty selection captured at server boot.
          await this.taskReadyHandler?.();
          this.refreshReadyStatus();
        })
        .catch(error => {
          const code = this.errorCode(error, "activation-failed");
          this.status = this.statusValue(code === "payload-missing" ? "blocked-error" : "repairable-error", null, safeError(code, productMessage(code)));
        })
        .finally(() => { this.bootstrapRun = null; });
    }
    return this.bootstrapStatus();
  }
  private statusValue(state: RuntimeBootstrapStatus["state"], phase: RuntimeBootstrapStatus["phase"], error: RuntimeBootstrapStatus["error"] = null): RuntimeBootstrapStatus {
    const hermes = Boolean(this.active.hermes), opencode = Boolean(this.active.opencode);
    const runtimeReady = hermes && opencode;
    const taskReady = runtimeReady && this.modelRouteState === "ready";
    return {
      schemaVersion: 1, state: taskReady ? "ready" : state, phase, progress: null,
      runtime: { kind: "hermes", version: hermes ? this.activeVersion("hermes") : null, source: hermes ? "managed" : null },
      readiness: { runtime: { state: runtimeReady ? "ready" : state === "checking" || state === "installing" ? "checking" : "error", hermes, opencode }, modelRoute: { state: this.modelRouteState }, taskReady, activeRuntime: this.activeRuntime() },
      canRetry: state === "repairable-error", canContinueLimited: !taskReady, error,
    };
  }
  private refreshReadyStatus() { this.status = this.statusValue("checking", null); }
  private activeRuntime(): ManagedRuntimeKind | null { return this.activePhases.hermes ? "hermes" : this.activePhases.opencode ? "opencode" : null; }
  private setPhase(kind: ManagedRuntimeKind, phase: RuntimeBootstrapStatus["phase"]) {
    if (phase) this.activePhases[kind] = phase; else delete this.activePhases[kind];
    if (this.bootstrapRun) this.status = this.statusValue("installing", phase);
  }
  private activeVersion(kind: ManagedRuntimeKind): string | null {
    try { return (JSON.parse(readFileSync(this.pointer(kind), "utf8")) as { version?: string }).version ?? null; } catch { return null; }
  }
  private errorCode(error: unknown, fallback: string) { return typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : fallback; }
  async stop() {
    if (this.routeMonitor) clearInterval(this.routeMonitor);
    this.routeMonitor = null; this.modelRouteState = "checking"; this.bridgeUrl = null;
    const children = [this.bridge, this.opencodeServer].filter((child): child is ReturnType<typeof spawn> => Boolean(child));
    this.bridge = null; this.opencodeServer = null;
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null) return;
      await Promise.race([new Promise<void>(resolveStop => child.once("exit", () => resolveStop())), new Promise<void>(resolveStop => setTimeout(resolveStop, 5_000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }));
  }
  private async startModelRoute() {
    await this.stop();
    const opencode = this.active.opencode, hermes = this.active.hermes;
    if (!opencode || !hermes) throw Object.assign(new Error("managed runtimes are incomplete"), { code: "model-route-failed" });
    const [upstreamPort, bridgePort] = await Promise.all([freeLoopbackPort(), freeLoopbackPort()]);
    if (upstreamPort === bridgePort) throw Object.assign(new Error("route port collision"), { code: "model-route-failed" });
    const bridgeScript = join(this.resourcesRoot, "opencode-bridge", "server.mjs");
    const bridgeTemplate = join(this.resourcesRoot, "opencode-bridge", "hermes-config.yaml");
    const hermesHome = join(this.installRoot, "hermes-home"); await mkdir(hermesHome, { recursive: true });
    const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
    const config = (await readFile(bridgeTemplate, "utf8")).replaceAll("http://127.0.0.1:4110", bridgeUrl);
    writeFileAtomic(join(hermesHome, "config.yaml"), config, { mode: 0o600 });
    process.env.HERMES_HOME = hermesHome;
    // The signed activation entry point is the ACP wrapper. The supervised
    // HTTP service is its sibling immutable OpenCode binary.
    const opencodeServer = join(dirname(opencode), process.platform === "win32" ? "opencode.exe" : "opencode");
    const opencodeServerInfo = await lstat(opencodeServer);
    if (!opencodeServerInfo.isFile() || opencodeServerInfo.isSymbolicLink()) throw Object.assign(new Error("OpenCode service executable is missing"), { code: "model-route-failed" });
    this.opencodeServer = spawn(opencodeServer, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(upstreamPort)], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.opencodeServer.once("exit", () => { this.setModelRouteReadiness("error"); });
    this.bridge = spawn(process.execPath, [bridgeScript], {
      stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OPENCODE_BIN: opencode, OPENCODE_SERVER_URL: `http://127.0.0.1:${upstreamPort}`, OPENCODE_BRIDGE_HOST: "127.0.0.1", OPENCODE_BRIDGE_PORT: String(bridgePort), OPENCODE_BRIDGE_TIMEOUT_MS: String(MANAGED_OPENCODE_PROMPT_TIMEOUT_MS), OPENCODE_FREE_MODEL: "opencode/big-pickle" },
    });
    this.bridge.once("exit", () => { this.setModelRouteReadiness("error"); });
    this.bridgeUrl = bridgeUrl;
    await waitForReady(`${bridgeUrl}/ready`, 30_000);
    // Do not publish taskReady yet. The awaited taskReadyHandler reloads the
    // provider registry and repairs/seeds the starter bot first.
    this.modelRouteState = "ready";
    this.routeMonitor = setInterval(() => { void this.checkRoute(); }, 10_000); this.routeMonitor.unref?.();
  }
  private async checkRoute() {
    if (!this.bridgeUrl) return;
    try { await requireReady(`${this.bridgeUrl}/ready`, 5_000); }
    catch { this.setModelRouteReadiness("error"); }
  }
  private pointer(kind: ManagedRuntimeKind) { return join(this.installRoot, kind, "current.json"); }
  private recoverActive(kind: ManagedRuntimeKind) {
    try {
      const pointer = JSON.parse(readFileSync(this.pointer(kind), "utf8")) as { version?: unknown; installation?: unknown; executable?: unknown; treeSha256?: unknown };
      if (typeof pointer.version !== "string" || typeof pointer.installation !== "string" || typeof pointer.executable !== "string" || typeof pointer.treeSha256 !== "string") return;
      const executable = safeJoin(join(this.installRoot, kind, safeManagedRuntimeRelativePath(pointer.installation)), pointer.executable);
      if (existsSync(executable)) this.active[kind] = executable;
    } catch { /* first launch or interrupted pointer write */ }
  }
  private manifestEntry(kind: ManagedRuntimeKind): RuntimeEntry {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(join(this.resourcesRoot, "manifests", `${kind}-${managedRuntimeTarget()}.manifest.json`), "utf8")); }
    catch { throw Object.assign(new Error("manifest unavailable"), { code: "payload-missing" }); }
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) throw Object.assign(new Error("manifest invalid"), { code: "manifest-invalid" });
    if (parsed.data.name !== payloadName(kind) || parsed.data.target !== managedRuntimeTarget()) throw Object.assign(new Error("target payload absent"), { code: "payload-missing" });
    return parsed.data;
  }
  private async activate(kind: ManagedRuntimeKind) {
    this.setPhase(kind, "verify-bundled");
    try {
      const entry = this.manifestEntry(kind);
      const archive = join(this.resourcesRoot, "archives", archiveName(entry));
      const archiveInfo = await lstat(archive);
      if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size !== entry.archiveSize) throw Object.assign(new Error("runtime archive size mismatch"), { code: "verification-failed" });
      if (await digestFile(archive) !== entry.archiveSha256) throw Object.assign(new Error("runtime archive digest mismatch"), { code: "verification-failed" });
      this.setPhase(kind, "activate");
      const kindRoot = join(this.installRoot, kind); await mkdir(kindRoot, { recursive: true });
      const manifestDigest = createHash("sha256").update(JSON.stringify(entry)).digest("hex");
      const installation = `${entry.version}-${manifestDigest.slice(0, 12)}`;
      const finalRoot = join(kindRoot, installation); const staging = join(kindRoot, `.staging-${randomUUID()}`);
      await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
      try {
        await extractArchive(entry, archive, staging);
        const stagedExecutable = safeJoin(staging, entry.executableRelPath);
        const executableInfo = await lstat(stagedExecutable);
        if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) throw Object.assign(new Error("runtime executable is invalid"), { code: "verification-failed" });
        if (process.platform !== "win32") await chmod(stagedExecutable, 0o755);
        for (const relPath of [entry.noticeRelPath, entry.sbomRelPath]) {
          const info = await lstat(safeJoin(staging, relPath));
          if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error("runtime legal metadata is missing"), { code: "verification-failed" });
        }
        this.setPhase(kind, "probe");
        await this.probe(kind, stagedExecutable, entry, staging);
        if (!existsSync(finalRoot)) await rename(staging, finalRoot);
        if (await inspectExtracted(finalRoot) !== entry.unpackedSize) throw Object.assign(new Error("existing activation size mismatch"), { code: "verification-failed" });
        const executable = safeJoin(finalRoot, entry.executableRelPath);
        const treeSha256 = await digestTree(finalRoot);
        writeFileAtomic(this.pointer(kind), `${JSON.stringify({ schemaVersion: 1, version: entry.version, installation, executable: entry.executableRelPath, treeSha256 })}\n`, { mode: 0o600 });
        this.active[kind] = executable;
        if (kind === "hermes") process.env.DANI_MANAGED_HERMES_EXECUTABLE = executable;
        else process.env.DANI_MANAGED_OPENCODE_EXECUTABLE = executable;
      } finally { await rm(staging, { recursive: true, force: true }).catch(() => undefined); }
    } finally { this.setPhase(kind, null); }
  }
  private async verifyRecovered(kind: ManagedRuntimeKind) {
    const executable = this.active[kind];
    if (!executable) throw Object.assign(new Error("runtime is not activated"), { code: "not-activated" });
    const entry = this.manifestEntry(kind);
    const pointer = JSON.parse(readFileSync(this.pointer(kind), "utf8")) as { version: string; installation: string; treeSha256: string };
    if (pointer.version !== entry.version) throw Object.assign(new Error("runtime version is stale"), { code: "verification-failed" });
    const root = join(this.installRoot, kind, safeManagedRuntimeRelativePath(pointer.installation));
    if (await inspectExtracted(root) !== entry.unpackedSize || await digestTree(root) !== pointer.treeSha256) throw Object.assign(new Error("managed runtime size mismatch"), { code: "verification-failed" });
    for (const relPath of [entry.noticeRelPath, entry.sbomRelPath]) {
      const info = await lstat(safeJoin(root, relPath));
      if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error("runtime legal metadata is missing"), { code: "verification-failed" });
    }
    await this.probe(kind, executable, entry, root);
  }
  private async probe(_kind: ManagedRuntimeKind, _executable: string, entry: RuntimeEntry, root: string) {
    const command = safeJoin(root, entry.probe.argv[0]!);
    const info = await lstat(command);
    if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error("runtime probe is invalid"), { code: "probe-failed" });
    const args = entry.probe.argv.slice(1);
    const result = process.platform === "win32" && command.toLowerCase().endsWith(".cmd")
      ? await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], 100_000)
      : await run(command, args, 100_000);
    const passAt = result.stdout.indexOf("PROBE RESULT:");
    const structured = (passAt < 0 ? result.stdout : result.stdout.slice(0, passAt)).trim();
    let agentVersion: unknown, agentName: unknown;
    try {
      const info = (JSON.parse(structured) as { result?: { agentInfo?: { name?: unknown; version?: unknown } } }).result?.agentInfo;
      agentVersion = info?.version; agentName = info?.name;
    } catch { throw Object.assign(new Error("runtime probe output was not structured JSON"), { code: "probe-failed" }); }
    const exactPass = `PROBE RESULT: PASS (${entry.probe.expectedAgentName} ${entry.probe.expectedVersion}, ACP initialize)`;
    if (agentName !== entry.probe.expectedAgentName || agentVersion !== entry.probe.expectedVersion || !result.stdout.split("\n").some(line => line.trim() === exactPass)) {
      throw Object.assign(new Error("runtime probe did not report an exact PASS"), { code: "probe-failed" });
    }
  }
}
