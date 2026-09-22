// Activating the bundled Hermes runtime (issue #18 acceptance criteria 1 and 3;
// spec 110 R-BOOT-002, R-RUNTIME-001..003; ADR-001).
//
// The product ships a per-target payload and owns its installation end to end.
// No shell installer, no package manager, no PATH mutation, no admin rights,
// and no network on the first-run path: the bytes are already on disk, so the
// only questions are whether they are the reviewed bytes and how to put them
// somewhere the app can launch by absolute path.
//
// Everything here fails closed. A missing manifest, a wrong digest, an unsafe
// archive member or a missing executable all leave the previous runtime exactly
// as it was, because a half-installed runtime is worse than an absent one: the
// user can recover from absent.
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export const MANIFEST_VERSION = 1;
const TAR_BLOCK = 512;
const INSTALL_RECORD = ".install-complete.json";

export type HermesTarget = "linux-x64" | "mac-arm64" | "mac-x64" | "win-x64";

export interface HermesManifest {
  manifestVersion: number;
  name: string;
  target: HermesTarget;
  version: string;
  archiveSha256: string;
  archiveSize: number;
  unpackedSize: number;
  format: "tar.gz";
  executableRelPath: string;
  degradations: string[];
}

export class HermesRuntimeError extends Error {
  // Declared and assigned rather than written as a constructor parameter
  // property: the server also runs under Node's strip-only type stripping,
  // which rejects any TypeScript that needs real transformation.
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HermesRuntimeError";
    this.code = code;
  }
}

/** The payload target for this machine, or null where none is published. */
export function selectTarget(platform: NodeJS.Platform, arch: string): HermesTarget | null {
  if (platform === "linux") return arch === "x64" ? "linux-x64" : null;
  if (platform === "win32") return arch === "x64" ? "win-x64" : null;
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : null;
  return null;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Validate a manifest before a single byte is trusted.
 *
 * Written against the shipped schema (scripts/hermes_manifest.py), and strict
 * on purpose: an unknown manifest version means the payload was built by a
 * different contract than this code implements, and guessing is how a verifier
 * silently stops verifying.
 */
export function parseManifest(raw: unknown): HermesManifest {
  const bad = (why: string): never => {
    throw new HermesRuntimeError("runtime.manifest-invalid", `runtime manifest is not usable: ${why}`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("not an object");
  const m = raw as Record<string, unknown>;
  if (m.manifestVersion !== MANIFEST_VERSION) return bad(`unsupported manifestVersion ${String(m.manifestVersion)}`);
  if (m.format !== "tar.gz") return bad(`unsupported format ${String(m.format)}`);
  const target = m.target;
  if (target !== "linux-x64" && target !== "mac-arm64" && target !== "mac-x64" && target !== "win-x64") {
    return bad(`unknown target ${String(target)}`);
  }
  if (typeof m.archiveSha256 !== "string" || !HEX64.test(m.archiveSha256)) {
    return bad("archiveSha256 must be 64 lowercase hex characters");
  }
  for (const key of ["archiveSize", "unpackedSize"] as const) {
    const value = m[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      return bad(`${key} must be a positive integer`);
    }
  }
  if (typeof m.executableRelPath !== "string" || !m.executableRelPath) return bad("executableRelPath is required");
  // The executable path is joined onto a directory this code creates, so it is
  // held to the same rules as any archive member.
  safeMemberPath(m.executableRelPath, "executableRelPath");
  if (typeof m.version !== "string" || !m.version) return bad("version is required");
  const degradations = Array.isArray(m.degradations)
    ? m.degradations.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    manifestVersion: MANIFEST_VERSION,
    name: typeof m.name === "string" ? m.name : "hermes-runtime-payload",
    target,
    version: m.version,
    archiveSha256: m.archiveSha256,
    archiveSize: m.archiveSize as number,
    unpackedSize: m.unpackedSize as number,
    format: "tar.gz",
    executableRelPath: m.executableRelPath,
    degradations,
  };
}

/**
 * Reject anything that could escape the destination directory.
 *
 * Absolute paths, drive letters, UNC prefixes, `..`, NUL and backslashes are
 * all refused rather than normalised, because normalising an attack into
 * something that looks safe is how traversal bugs survive review.
 */
export function safeMemberPath(name: string, label = "archive member"): string {
  const why = (reason: string): never => {
    throw new HermesRuntimeError("runtime.archive-unsafe", `unsafe ${label} (${reason}): ${JSON.stringify(name)}`);
  };
  if (!name) why("empty");
  if (name.includes("\0")) why("NUL byte");
  if (name.includes("\\")) why("backslash");
  if (name.startsWith("/")) why("absolute");
  if (/^[A-Za-z]:/.test(name)) why("drive letter");
  const parts = name.split("/").filter((part) => part !== "");
  if (parts.length === 0) why("no components");
  for (const part of parts) {
    if (part === "..") why("parent traversal");
    if (part === ".") why("current-directory component");
  }
  return parts.join("/");
}

function tarText(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function tarOctal(block: Buffer, start: number, length: number, label: string): number {
  const raw = tarText(block, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new HermesRuntimeError("runtime.archive-invalid", `invalid tar ${label}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HermesRuntimeError("runtime.archive-invalid", `invalid tar ${label}`);
  }
  return value;
}

function headerChecksum(block: Buffer): number {
  const copy = Buffer.from(block);
  copy.fill(0x20, 148, 156);
  return copy.reduce((sum, byte) => sum + byte, 0);
}

export interface ExtractResult {
  files: number;
  bytes: number;
}

/**
 * Stream a gzipped tar into `destination`.
 *
 * Streaming rather than buffering: the payload unpacks to a few hundred
 * megabytes, and a first run that needs all of it resident at once is a first
 * run that fails on a small machine.
 *
 * Only regular files and directories are written. Links of either kind,
 * devices, FIFOs and sparse/PAX/GNU extensions are refused outright: a runtime
 * payload has no legitimate use for them, and each is a way out of the
 * destination directory. `budget` bounds the expanded size so a corrupt or
 * hostile archive cannot fill the disk after passing the digest check.
 */
export async function extractTarGz(
  archivePath: string,
  destination: string,
  budget: number,
): Promise<ExtractResult> {
  const root = resolve(destination);
  let pending = Buffer.alloc(0);
  let written = 0;
  let files = 0;
  let sawEnd = false;
  let active: { handle: FileHandle; remaining: number; padding: number } | null = null;
  const openHandles = new Set<FileHandle>();
  const fail = (code: string, message: string) => new HermesRuntimeError(code, message);

  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      void (async () => {
        try {
          pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
          for (;;) {
            if (active) {
              if (pending.length === 0) break;
              const take = Math.min(active.remaining, pending.length);
              if (take > 0) {
                await active.handle.write(pending.subarray(0, take));
                active.remaining -= take;
                pending = pending.subarray(take);
              }
              if (active.remaining > 0) break;
              const skip = Math.min(active.padding, pending.length);
              active.padding -= skip;
              pending = pending.subarray(skip);
              if (active.padding > 0) break;
              await active.handle.close();
              openHandles.delete(active.handle);
              active = null;
              continue;
            }
            if (pending.length < TAR_BLOCK) break;
            const block = pending.subarray(0, TAR_BLOCK);
            pending = pending.subarray(TAR_BLOCK);
            if (block.every((byte) => byte === 0)) {
              sawEnd = true;
              continue;
            }
            // Content after the end-of-archive marker is not a formatting
            // quirk; it is bytes nobody reviewed.
            if (sawEnd) throw fail("runtime.archive-invalid", "data after the end of the archive");
            if (tarOctal(block, 148, 8, "checksum") !== headerChecksum(block)) {
              throw fail("runtime.archive-invalid", "invalid tar header checksum");
            }
            const prefix = tarText(block, 345, 155);
            const base = tarText(block, 0, 100);
            const name = safeMemberPath(prefix ? `${prefix}/${base}` : base);
            const typeByte = block[156]!;
            const size = tarOctal(block, 124, 12, "member size");
            const mode = tarOctal(block, 100, 8, "mode");
            if (tarText(block, 157, 100)) throw fail("runtime.archive-unsafe", `links are not allowed: ${name}`);

            const target = resolve(root, name);
            // Belt and braces: even with a validated name, confirm the
            // resolved path is still inside the destination.
            if (target !== root && !target.startsWith(root + sep)) {
              throw fail("runtime.archive-unsafe", `member escapes the destination: ${name}`);
            }

            if (typeByte === 0x35) {
              await mkdir(target, { recursive: true });
              continue;
            }
            if (typeByte !== 0 && typeByte !== 0x30) {
              throw fail("runtime.archive-unsafe", `unsupported member type ${typeByte} for ${name}`);
            }
            written += size;
            if (written > budget) throw fail("runtime.archive-oversize", "archive expands beyond its declared size");
            await mkdir(dirname(target), { recursive: true });
            const handle = await open(target, "w");
            openHandles.add(handle);
            files += 1;
            // Preserve only the owner execute bit. Setuid, setgid and sticky
            // are dropped: a runtime payload never needs them, and honouring
            // them would turn an archive member into a privilege bug.
            if (process.platform !== "win32" && (mode & 0o100) !== 0) await chmod(target, 0o755);
            active = { handle, remaining: size, padding: (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK };
          }
          callback();
        } catch (error) {
          callback(error as Error);
        }
      })();
    },
  });

  try {
    await pipeline(createReadStream(archivePath), createGunzip(), sink);
  } finally {
    for (const handle of openHandles) await handle.close().catch(() => {});
  }
  if (active) throw fail("runtime.archive-invalid", "archive ended inside a member");
  if (!sawEnd) throw fail("runtime.archive-invalid", "archive has no end-of-archive marker");
  return { files, bytes: written };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export interface ActivationLayout {
  /** Where verified versions live, e.g. <dataDir>/runtimes/hermes. */
  root: string;
  /** The activated runtime directory for this digest. */
  versionDir: string;
  /** Absolute path to the runtime executable. */
  executable: string;
  version: string;
  digest: string;
}

function layoutFor(dataDir: string, manifest: HermesManifest): ActivationLayout {
  const root = join(dataDir, "runtimes", "hermes");
  const versionDir = join(root, "versions", manifest.archiveSha256);
  return {
    root,
    versionDir,
    executable: join(versionDir, ...manifest.executableRelPath.split("/")),
    version: manifest.version,
    digest: manifest.archiveSha256,
  };
}

/** A completed install for this exact digest, or null. */
export async function installedRuntime(
  dataDir: string,
  manifest: HermesManifest,
): Promise<ActivationLayout | null> {
  const layout = layoutFor(dataDir, manifest);
  try {
    const record = JSON.parse(await readFile(join(layout.versionDir, INSTALL_RECORD), "utf8")) as {
      digest?: string;
      version?: string;
    };
    if (record.digest !== manifest.archiveSha256 || record.version !== manifest.version) return null;
  } catch {
    return null;
  }
  // The record is a claim; the executable is the fact.
  return existsSync(layout.executable) ? layout : null;
}

// One activation per destination at a time. First run, a retry click and a
// relaunch can all arrive together, and two extractions into the same staging
// directory is the race that produces a runtime nobody can explain.
const inFlight = new Map<string, Promise<ActivationLayout>>();

export interface ActivateOptions {
  /** Directory holding <target>.tar.gz and <target>.manifest.json. */
  payloadDir: string;
  dataDir: string;
  target: HermesTarget;
  /** Distinguishes concurrent staging directories in tests. */
  stagingSuffix?: string;
}

/**
 * Verify and activate the bundled payload, atomically.
 *
 * The order is the whole design: digest first, extract into staging second,
 * prove the executable exists third, and only then rename into place. The
 * running runtime is never written through, so an interruption at any point
 * leaves the last verified version serving.
 */
export function activateBundledRuntime(options: ActivateOptions): Promise<ActivationLayout> {
  const key = `${resolve(options.dataDir)}::${options.target}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = activateOnce(options).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function activateOnce(options: ActivateOptions): Promise<ActivationLayout> {
  const { payloadDir, dataDir, target } = options;
  const manifestPath = join(payloadDir, `${target}.manifest.json`);
  const archivePath = join(payloadDir, `${target}.tar.gz`);

  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, "utf8");
  } catch {
    throw new HermesRuntimeError("runtime.payload-missing", "this installation does not carry a runtime for this system");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    throw new HermesRuntimeError("runtime.manifest-invalid", "runtime manifest is not valid JSON");
  }
  const manifest = parseManifest(parsed);
  if (manifest.target !== target) {
    throw new HermesRuntimeError("runtime.manifest-invalid", "runtime manifest describes a different system");
  }

  // Reuse a completed install rather than re-extracting a few hundred
  // megabytes on every launch.
  const already = await installedRuntime(dataDir, manifest);
  if (already) return already;

  let archiveStat;
  try {
    archiveStat = await stat(archivePath);
  } catch {
    throw new HermesRuntimeError("runtime.payload-missing", "this installation does not carry a runtime for this system");
  }
  if (archiveStat.size !== manifest.archiveSize) {
    throw new HermesRuntimeError("runtime.digest-mismatch", "the bundled runtime does not match its manifest");
  }
  if ((await sha256File(archivePath)) !== manifest.archiveSha256) {
    throw new HermesRuntimeError("runtime.digest-mismatch", "the bundled runtime does not match its manifest");
  }

  const layout = layoutFor(dataDir, manifest);
  const staging = `${layout.versionDir}.staging${options.stagingSuffix ? `-${options.stagingSuffix}` : ""}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(dirname(layout.versionDir), { recursive: true });
  await mkdir(staging, { recursive: true });

  try {
    // A little headroom over the declared size: tar rounds members up to
    // 512-byte blocks, so the written total can exceed the recorded tree size.
    await extractTarGz(archivePath, staging, manifest.unpackedSize + 64 * 1024 * 1024);
    const stagedExecutable = join(staging, ...manifest.executableRelPath.split("/"));
    if (!existsSync(stagedExecutable)) {
      throw new HermesRuntimeError("runtime.executable-missing", "the bundled runtime is incomplete");
    }
    if (process.platform !== "win32") await chmod(stagedExecutable, 0o755);
    await writeFile(
      join(staging, INSTALL_RECORD),
      JSON.stringify({
        digest: manifest.archiveSha256,
        version: manifest.version,
        target,
        completedAt: new Date().toISOString(),
      }),
    );
    // The record is written inside staging, so the directory only becomes
    // visible under its final name once it is already complete.
    await rm(layout.versionDir, { recursive: true, force: true });
    await rename(staging, layout.versionDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return layout;
}

/** Remove a version that failed its own verification, so repair can retry. */
export async function discardRuntime(dataDir: string, manifest: HermesManifest): Promise<void> {
  await rm(layoutFor(dataDir, manifest).versionDir, { recursive: true, force: true });
}
