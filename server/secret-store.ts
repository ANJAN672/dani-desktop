// SecretStore — one abstraction over where provider credentials live, per
// runtime mode. This is the server side of the no-plaintext guarantee:
//
//   desktop            The Electron shell owns an OS-encrypted store
//                      (safeStorage credentials.bin). The server sees secrets
//                      only as env vars injected at spawn and must never
//                      persist them itself.
//   headless           No OS store exists. Secrets arrive transiently via env
//                      or file-descriptor injection (<VAR>_FD) and are never
//                      written to disk.
//   insecure-local-dev Explicit opt-in (DANI_INSECURE_LOCAL_DEV=1), OFF by
//                      default, with a loud warning. Legacy plaintext
//                      config.json behavior, local development only.
//   (default)          None of the above: FAIL CLOSED. Saving a credential is
//                      refused and booting with uncovered plaintext secrets is
//                      refused. The one unacceptable outcome — silently losing
//                      the only copy of a secret — never happens.
//
// Pure functions stay in this module so the migration decisions are testable
// without a running server. server/index.ts owns the boot hook and the
// config-PATCH integration.
import { closeSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

/** Canonical provider-secret locations in config.json, with the env var that
 * carries each secret at runtime. Keep in sync with syncCredentialEnv() and
 * the desktop shell's WORKSPACE_CREDENTIALS (electron/workspace-credentials.mjs). */
export const SECRET_PATHS = [
  { section: "xai", field: "key", env: "XAI_API_KEY", label: "xai.key" },
  { section: "openaiCompat", field: "key", env: "OPENAI_COMPAT_API_KEY", label: "openaiCompat.key" },
  { section: "composio", field: "apiKey", env: "COMPOSIO_API_KEY", label: "composio.apiKey" },
  { section: "box", field: "token", env: "BOX_TOKEN", label: "box.token" },
  { section: "opencodeGo", field: "apiKey", env: "OPENCODE_API_KEY", label: "opencodeGo.apiKey" },
  { section: "tts", field: "key", env: "DANI_TTS_KEY", legacyEnv: "OMB_TTS_KEY", label: "tts.key" },
  { section: "imageGen", field: "key", env: "DANI_OPENAI_IMAGE_KEY", legacyEnv: "OMB_OPENAI_IMAGE_KEY", label: "imageGen.key" },
] as const;

/** Every env name (primary + legacy rebrand alias) that can carry a secret.
 * loadConfig reads DANI_* first and falls back to OMB_*; coverage and fd
 * injection must accept both or the packaged shell's injection reads as
 * "uncovered". */
function envNamesOf(entry: (typeof SECRET_PATHS)[number]): string[] {
  return "legacyEnv" in entry ? [entry.env, entry.legacyEnv as string] : [entry.env];
}

/** Legacy fields the desktop shell already deletes at boot (no longer read
 * anywhere). Scrubbed wherever found, never treated as live secrets. */
const LEGACY_SCRUB_PATHS = [
  { section: "composio", field: "key" },
  { section: "composio", field: "url" },
] as const;

export type SecretStoreKind = "desktop" | "headless" | "insecure-local-dev";

export interface SecretStoreMode {
  kind: SecretStoreKind;
  /** True when no secure backend is available: persist/refuse decisions must
   * fail closed rather than fall back to plaintext. */
  failClosed: boolean;
  /** Loud, human-readable warning for the insecure opt-in; null otherwise. */
  warning: string | null;
}

export const INSECURE_LOCAL_DEV_VAR = "DANI_INSECURE_LOCAL_DEV";
// Same dual-name rule as index.ts: the rebranded shell sets DANI_DESKTOP_PARENT;
// OMB_DESKTOP_PARENT remains as the legacy alias.
const DESKTOP_PARENT_VARS = ["DANI_DESKTOP_PARENT", "OMB_DESKTOP_PARENT"] as const;

function insecureDevWarning(dataDir: string): string {
  return [
    "[DANI SECURITY] DANI_INSECURE_LOCAL_DEV=1 — INSECURE LOCAL DEVELOPMENT MODE.",
    `[DANI SECURITY] Provider credentials are stored as PLAINTEXT in ${join(dataDir, "config.json")}.`,
    "[DANI SECURITY] Local development only. Never use with real keys on a shared or networked machine.",
  ].join("\n");
}

/** Resolve which secret-store mode the server runs in. The insecure mode is
 * strictly opt-in: only the exact value "1" enables it, and it is OFF by
 * default. Anything else (including "0", "", "true") fails closed. */
export function resolveSecretStore(
  env: NodeJS.ProcessEnv = process.env,
  dataDir?: string,
): SecretStoreMode {
  if (DESKTOP_PARENT_VARS.some((name) => env[name] === "1")) {
    return { kind: "desktop", failClosed: false, warning: null };
  }
  if (env[INSECURE_LOCAL_DEV_VAR] === "1") {
    return {
      kind: "insecure-local-dev",
      failClosed: false,
      warning: insecureDevWarning(dataDir ?? defaultDataDir(env)),
    };
  }
  return { kind: "headless", failClosed: true, warning: null };
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  return env.DANI_DATA_DIR ?? env.OMB_DATA_DIR ?? join(env.HOME ?? "~", ".danibot");
}

type JsonRecord = Record<string, unknown>;

function sectionOf(document: unknown, section: string): JsonRecord | null {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const value = (document as JsonRecord)[section];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function deepCopy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** Deep copy of an unknown JSON-ish value, normalized to a plain record. */
function copyJsonObject(value: unknown): JsonRecord {
  const copy: unknown = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  if (copy && typeof copy === "object" && !Array.isArray(copy)) return copy as JsonRecord;
  return {};
}

/** Split a config document into its provider secrets and a scrubbed copy.
 * Secret fields are DELETED (never blanked) so the scrubbed document cannot
 * be mistaken for an explicit "clear this credential". Legacy unread fields
 * are deleted too. Inputs are treated as immutable. */
export function extractSecrets(document: unknown): {
  secrets: Record<string, string>;
  scrubbed: JsonRecord;
} {
  const scrubbed: JsonRecord = copyJsonObject(document);
  const secrets: Record<string, string> = {};
  for (const { section, field, label } of SECRET_PATHS) {
    const home = sectionOf(scrubbed, section);
    if (!home || !Object.hasOwn(home, field)) continue;
    const value = home[field];
    if (typeof value === "string" && value.trim() !== "") secrets[label] = value;
    delete home[field];
  }
  for (const { section, field } of LEGACY_SCRUB_PATHS) {
    const home = sectionOf(scrubbed, section);
    if (home && Object.hasOwn(home, field)) delete home[field];
  }
  return { secrets, scrubbed };
}

/** Dotted labels (e.g. "xai.key") of every non-empty provider secret present
 * as plaintext in the document. */
export function plaintextSecretsPresent(document: unknown): string[] {
  const found: string[] = [];
  for (const { section, field, label } of SECRET_PATHS) {
    const home = sectionOf(document, section);
    const value = home?.[field];
    if (typeof value === "string" && value.trim() !== "") found.push(label);
  }
  return found;
}

/** Dotted labels of secret fields a config PATCH touches (any value,
 * including ""), i.e. fields the save path must not persist as plaintext. */
export function secretLabelsInPatch(patch: unknown): string[] {
  const found: string[] = [];
  for (const { section, field, label } of SECRET_PATHS) {
    const home = sectionOf(patch, section);
    if (home && Object.hasOwn(home, field) && home[field] !== undefined) found.push(label);
  }
  return found;
}

function secretPathByLabel(label: string): (typeof SECRET_PATHS)[number] | undefined {
  return SECRET_PATHS.find((entry) => entry.label === label);
}

/** True when the runtime env already carries the secret (injected at boot by
 * the desktop shell, or exported/injected by a headless operator). env wins
 * over the file in loadConfig(), so a covered secret survives a scrub. */
export function secretCoveredByEnv(label: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const entry = secretPathByLabel(label);
  if (!entry) return false;
  return envNamesOf(entry).some((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim() !== "";
  });
}

export interface SecretStoreIo {
  readFile(path: string): string;
  writeAtomic(path: string, data: string): void;
  readFd(fd: number): string;
}

export const nodeSecretStoreIo: SecretStoreIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeAtomic: (path, data) => writeFileAtomic(path, data, { mode: 0o600 }),
  readFd: (fd) => {
    try {
      return readFileSync(fd, "utf8");
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* already closed or never open — the read error below carries the signal */
      }
    }
  },
};

/** File-descriptor injection for headless operators: <VAR>_FD=N reads the
 * secret once from fd N at boot, installs it in env (which loadConfig()
 * already prefers), and removes the _FD marker. A bad fd or an empty read
 * fails closed — booting without the secret the operator intended would
 * silently strand the deployment. */
export function importFdInjectedSecrets(
  env: NodeJS.ProcessEnv = process.env,
  io: SecretStoreIo = nodeSecretStoreIo,
): string[] {
  const injected: string[] = [];
  for (const entry of SECRET_PATHS) {
    for (const name of envNamesOf(entry)) {
    const fdName = `${name}_FD`;
    const raw = env[fdName];
    if (raw === undefined) continue;
    delete env[fdName];
    if (raw.trim() === "") continue;
    const fd = Number(raw);
    if (!Number.isInteger(fd) || fd < 0) {
      throw new Error(
        `[DANI SECURITY] refusing to boot: ${fdName}=${JSON.stringify(raw)} is not a valid file descriptor`,
      );
    }
    let value: string;
    try {
      value = io.readFd(fd);
    } catch (error) {
      throw new Error(
        `[DANI SECURITY] refusing to boot: could not read the ${name} secret from fd ${fd} (${fdName}): ${(error as Error)?.message ?? error}`,
      );
    }
    if (value.trim() === "") {
      throw new Error(
        `[DANI SECURITY] refusing to boot: ${fdName} (fd ${fd}) delivered an empty secret`,
      );
    }
    env[name] = value.trim();
    injected.push(name);
    }
  }
  return injected;
}

export interface BootScrubOptions {
  dataDir: string;
  store: SecretStoreMode;
  env?: NodeJS.ProcessEnv;
  io?: SecretStoreIo;
  onWarning?: (message: string) => void;
}

export interface BootScrubResult {
  scrubbed: boolean;
  /** Dotted labels removed from config.json (informational only — the values
   * themselves never leave the process). */
  removed: string[];
}

/** Boot-time plaintext migration, transactional:
 *   import → verify coverage → scrub config → fsync/atomic replace → verify.
 *
 * Every plaintext secret must already be covered by env/fd injection before
 * the file is touched. In headless mode an uncovered secret refuses the boot
 * (the file is left untouched); in desktop mode the shell retries on the next
 * launch, so uncovered secrets are left in place with a loud warning instead.
 *
 * There is no backup file and no restore path: the pre-image exists only in
 * memory during this call, so a rollback can never reintroduce plaintext.
 * writeFileAtomic's rename means readers see the old or the new document,
 * never a partial one; a failed verify throws without writing anything else.
 */
export function scrubPlaintextSecretsAtBoot(options: BootScrubOptions): BootScrubResult {
  const { dataDir, store, env = process.env, io = nodeSecretStoreIo, onWarning } = options;
  const warn = onWarning ?? ((message: string) => console.error(message));
  const configPath = join(dataDir, "config.json");
  let raw: string;
  try {
    raw = io.readFile(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { scrubbed: false, removed: [] };
    throw error;
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    // Unparseable config is the existing loader's problem (it treats the
    // file as absent); never touch what we cannot understand.
    return { scrubbed: false, removed: [] };
  }
  const present = plaintextSecretsPresent(document);
  if (present.length === 0) return { scrubbed: false, removed: [] };
  if (store.kind === "insecure-local-dev") {
    warn(`${store.warning}\n[DANI SECURITY] leaving ${present.length} plaintext credential(s) in config.json (insecure local dev mode).`);
    return { scrubbed: false, removed: [] };
  }
  const uncovered = present.filter((label) => !secretCoveredByEnv(label, env));
  if (uncovered.length > 0) {
    const names = uncovered
      .map((label) => `${label} (${secretPathByLabel(label)?.env})`)
      .join(", ");
    if (store.kind === "headless") {
      // Fail closed: destroying the only copy to satisfy the scrub would be
      // worse than refusing to start. The file is left untouched.
      throw new Error(
        `[DANI SECURITY] refusing to boot: config.json holds plaintext credentials with no secure store and no injected replacement: ${names}. ` +
          `Export each key to its env var, inject it via <VAR>_FD, or set ${INSECURE_LOCAL_DEV_VAR}=1 for local development.`,
      );
    }
    warn(
      `[DANI SECURITY] the OS credential store was unavailable this launch; leaving plaintext ${uncovered.join(", ")} in config.json so a later launch can retry the migration.`,
    );
    // Scrub only what is safely covered; the shell retries the rest.
    const covered = new Set(present.filter((label) => secretCoveredByEnv(label, env)));
    if (covered.size === 0) return { scrubbed: false, removed: [] };
    return scrubCovered(configPath, document, covered, io);
  }
  return scrubCovered(configPath, document, new Set(present), io);
}

function scrubCovered(
  configPath: string,
  document: unknown,
  covered: ReadonlySet<string>,
  io: SecretStoreIo,
): BootScrubResult {
  const scrubbedDoc: JsonRecord = copyJsonObject(document);
  const removed: string[] = [];
  for (const label of covered) {
    const entry = secretPathByLabel(label);
    if (!entry) continue;
    const home = sectionOf(scrubbedDoc, entry.section);
    if (home && Object.hasOwn(home, entry.field)) {
      delete home[entry.field];
      removed.push(label);
    }
  }
  for (const { section, field } of LEGACY_SCRUB_PATHS) {
    const home = sectionOf(scrubbedDoc, section);
    if (home && Object.hasOwn(home, field)) delete home[field];
  }
  if (removed.length === 0) return { scrubbed: false, removed: [] };
  // Atomic replace (fsync + rename): an interrupted write leaves the old
  // document intact, never a truncated one.
  io.writeAtomic(configPath, JSON.stringify(scrubbedDoc, null, 2));
  // Verify the scrub landed: every secret we intended to remove must be gone.
  // (Uncovered secrets deliberately left for a later desktop retry are not
  // part of this write's contract.) On failure, throw WITHOUT restoring
  // anything: there is no plaintext backup to restore from, by design.
  const remaining = plaintextSecretsPresent(JSON.parse(io.readFile(configPath)));
  const failed = removed.filter((label) => remaining.includes(label));
  if (failed.length > 0) {
    throw new Error(
      `[DANI SECURITY] credential scrub verification failed — ${failed.join(", ")} still present after atomic replace. Refusing to continue; no plaintext was restored.`,
    );
  }
  return { scrubbed: true, removed };
}

export interface SecretAwareSaveInput {
  /** The parsed config PATCH. */
  patch: Record<string, unknown>;
  store: SecretStoreMode;
  /** ?secretStorage=external — only meaningful when the desktop shell is the
   * parent: it committed the secrets to the OS store before this request. */
  externalSecretStorage: boolean;
  saveConfig: (patch: Record<string, unknown>) => void;
  onWarning?: (message: string) => void;
}

export interface SecretAwareSaveResult {
  /** What was written to config.json. */
  persistedPatch: Record<string, unknown>;
  /** What the running process should adopt in-memory (syncCredentialEnv). */
  envPatch: Record<string, unknown>;
  /** Dotted labels the store refused to persist (fail-closed headless). */
  refused: string[];
}

/** Route a config PATCH's secret fields through the SecretStore instead of
 * letting them land as plaintext in config.json.
 *
 * - insecure-local-dev: legacy behavior (plaintext allowed), loud warning.
 * - desktop + external flag: the shell already committed to credentials.bin;
 *   persist non-secret siblings and write "" tombstones so a stale plaintext
 *   value can never survive the merge.
 * - desktop WITHOUT the flag: fail closed — secrets bypassed the shell's
 *   encrypted commit, so the whole request is refused before anything is saved.
 * - headless (fail closed): persist the non-secret fields, refuse the secret
 *   fields with a 409 naming them and the remediation.
 */
export function applySecretAwareConfigSave(input: SecretAwareSaveInput): SecretAwareSaveResult {
  const { patch, store, externalSecretStorage, saveConfig, onWarning } = input;
  const warn = onWarning ?? ((message: string) => console.error(message));
  const labels = secretLabelsInPatch(patch);

  if (store.kind === "insecure-local-dev") {
    warn(`${store.warning}\n[DANI SECURITY] persisting ${labels.length} credential field(s) as plaintext (insecure local dev mode).`);
    saveConfig(patch);
    return { persistedPatch: patch, envPatch: patch, refused: [] };
  }

  if (store.kind === "desktop") {
    if (labels.length === 0) {
      saveConfig(patch);
      return { persistedPatch: patch, envPatch: patch, refused: [] };
    }
    if (!externalSecretStorage) {
      throw Object.assign(
        new Error(
          "[DANI SECURITY] refusing to save credentials: they did not come through the desktop shell's encrypted credential store. " +
            "Save credentials through the app's settings UI (credential:set), not the config API directly.",
        ),
        { status: 409 },
      );
    }
    // Tombstones keep the merge from resurrecting an older plaintext value;
    // the real secrets are already in credentials.bin and injected env.
    const persistedPatch = deepCopy(patch);
    for (const label of labels) {
      const entry = secretPathByLabel(label);
      if (!entry) continue;
      const home = sectionOf(persistedPatch, entry.section);
      if (home) home[entry.field] = "";
    }
    saveConfig(persistedPatch);
    return { persistedPatch, envPatch: patch, refused: [] };
  }

  // headless: fail closed. Non-secret siblings still persist; every secret
  // field is refused with a named remediation instead of hitting the disk.
  const persistedPatch = deepCopy(patch);
  for (const label of labels) {
    const entry = secretPathByLabel(label);
    if (!entry) continue;
    const home = sectionOf(persistedPatch, entry.section);
    if (home) delete home[entry.field];
  }
  saveConfig(persistedPatch);
  return { persistedPatch, envPatch: persistedPatch, refused: labels };
}

/** Human-readable 409 body for refused secret fields. */
export function refusedSecretsMessage(refused: string[]): string {
  const names = refused
    .map((label) => `${label} (${secretPathByLabel(label)?.env})`)
    .join(", ");
  return (
    `[DANI SECURITY] refusing to persist credentials as plaintext: ${names}. ` +
    `Provide them via environment or <VAR>_FD file-descriptor injection instead, ` +
    `or set ${INSECURE_LOCAL_DEV_VAR}=1 for local development (plaintext, never for real keys). ` +
    "Non-secret settings in the same request were saved."
  );
}
