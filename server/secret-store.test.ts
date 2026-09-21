// SecretStore migration tests — fixture keys only, never real secrets.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applySecretAwareConfigSave,
  extractSecrets,
  importFdInjectedSecrets,
  nodeSecretStoreIo,
  plaintextSecretsPresent,
  refusedSecretsMessage,
  resolveSecretStore,
  scrubPlaintextSecretsAtBoot,
  secretLabelsInPatch,
  type SecretStoreIo,
  type SecretStoreMode,
} from "./secret-store.ts";

const FIX = {
  xai: "xai-fixture-key-1111",
  openaiCompat: "openai-compat-fixture-key-2222",
  composio: "ak_fixture_3333",
  box: "box-fixture-token-4444",
  opencodeGo: "opencode-fixture-key-5555",
  tts: "tts-fixture-key-6666",
  imageGen: "image-fixture-key-7777",
};

function plaintextConfig(extra: Record<string, unknown> = {}) {
  return {
    xai: { key: FIX.xai },
    openaiCompat: { key: FIX.openaiCompat, model: "fixture-model" },
    composio: { apiKey: FIX.composio, userId: "fixture-user" },
    box: { token: FIX.box },
    opencodeGo: { apiKey: FIX.opencodeGo },
    tts: { key: FIX.tts, provider: "elevenlabs" },
    imageGen: { key: FIX.imageGen },
    language: "en",
    ...extra,
  };
}

function coveredEnv(): NodeJS.ProcessEnv {
  return {
    XAI_API_KEY: FIX.xai,
    OPENAI_COMPAT_API_KEY: FIX.openaiCompat,
    COMPOSIO_API_KEY: FIX.composio,
    BOX_TOKEN: FIX.box,
    OPENCODE_API_KEY: FIX.opencodeGo,
    OMB_TTS_KEY: FIX.tts,
    OMB_OPENAI_IMAGE_KEY: FIX.imageGen,
  };
}

/** In-memory fs double: files keyed by path, optional write failure. */
function memoryIo(files: Record<string, string>, opts: { failWrite?: boolean } = {}): SecretStoreIo & {
  files: Record<string, string>;
  writes: number;
  readFdImpl: ((fd: number) => string) | undefined;
} {
  const io: SecretStoreIo & {
    files: Record<string, string>;
    writes: number;
    readFdImpl: ((fd: number) => string) | undefined;
  } = {
    files,
    writes: 0,
    readFdImpl: undefined,
    readFile: (path: string) => {
      if (!(path in files)) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return files[path]!;
    },
    writeAtomic: (path: string, data: string) => {
      io.writes += 1;
      if (opts.failWrite) throw new Error("simulated interrupted write");
      files[path] = data;
    },
    readFd: (fd: number) => {
      if (io.readFdImpl) return io.readFdImpl(fd);
      throw new Error(`bad fd ${fd}`);
    },
  };
  return io;
}

const CONFIG_PATH = "/fixture/.danibot/config.json";
const headless: SecretStoreMode = { kind: "headless", failClosed: true, warning: null };
const desktop: SecretStoreMode = { kind: "desktop", failClosed: false, warning: null };

describe("resolveSecretStore", () => {
  it("fails closed by default (headless, no opt-ins)", () => {
    const mode = resolveSecretStore({});
    expect(mode.kind).toBe("headless");
    expect(mode.failClosed).toBe(true);
    expect(mode.warning).toBeNull();
  });

  it("requires explicit opt-in for the insecure local-dev mode", () => {
    for (const value of ["0", "", "true", "yes", "2"]) {
      const mode = resolveSecretStore({ DANI_INSECURE_LOCAL_DEV: value });
      expect(mode.kind).toBe("headless");
      expect(mode.failClosed).toBe(true);
    }
    const mode = resolveSecretStore({ DANI_INSECURE_LOCAL_DEV: "1" }, "/fixture/.danibot");
    expect(mode.kind).toBe("insecure-local-dev");
    expect(mode.failClosed).toBe(false);
    expect(mode.warning).toContain("DANI_INSECURE_LOCAL_DEV=1");
    expect(mode.warning).toContain("PLAINTEXT");
  });

  it("recognizes the desktop shell as the secret owner", () => {
    const mode = resolveSecretStore({ OMB_DESKTOP_PARENT: "1" });
    expect(mode.kind).toBe("desktop");
    expect(mode.failClosed).toBe(false);
  });
});

describe("extractSecrets", () => {
  it("splits secrets out and deletes (never blanks) the fields", () => {
    const doc = plaintextConfig();
    const { secrets, scrubbed } = extractSecrets(doc);
    expect(Object.keys(secrets)).toHaveLength(7);
    expect(secrets["xai.key"]).toBe(FIX.xai);
    expect(secrets["composio.apiKey"]).toBe(FIX.composio);
    // non-secret siblings survive
    expect((scrubbed.openaiCompat as Record<string, unknown>).model).toBe("fixture-model");
    expect((scrubbed.composio as Record<string, unknown>).userId).toBe("fixture-user");
    expect(scrubbed.language).toBe("en");
    // secret fields are gone, not blanked
    for (const [section, field] of [["xai", "key"], ["box", "token"], ["tts", "key"]] as const) {
      expect(Object.hasOwn((scrubbed as Record<string, Record<string, unknown>>)[section]!, field)).toBe(false);
    }
    // input untouched (immutable)
    expect((doc.xai as Record<string, unknown>).key).toBe(FIX.xai);
  });

  it("removes legacy unread composio.key/url fields", () => {
    const { scrubbed, secrets } = extractSecrets({
      composio: { key: "legacy-connect-key", url: "https://old.example", apiKey: FIX.composio },
    });
    expect(scrubbed.composio).toEqual({});
    expect(Object.hasOwn(scrubbed.composio as object, "key")).toBe(false);
    expect(Object.hasOwn(scrubbed.composio as object, "url")).toBe(false);
    expect(secrets["composio.apiKey"]).toBe(FIX.composio);
    expect("composio.key" in secrets).toBe(false);
  });

  it("ignores empty and non-string fields", () => {
    const { secrets, scrubbed } = extractSecrets({ xai: { key: "" }, box: { token: 42 } });
    expect(secrets).toEqual({});
    expect(plaintextSecretsPresent(scrubbed)).toEqual([]);
  });
});

describe("scrubPlaintextSecretsAtBoot", () => {
  let warnings: string[];
  beforeEach(() => {
    warnings = [];
  });
  const onWarning = (message: string) => warnings.push(message);

  it("success: migrates env-covered plaintext secrets and verifies the scrub", () => {
    const io = memoryIo({ [CONFIG_PATH]: JSON.stringify(plaintextConfig()) });
    const env = coveredEnv();
    const result = scrubPlaintextSecretsAtBoot({
      dataDir: "/fixture/.danibot",
      store: headless,
      env,
      io,
      onWarning,
    });
    expect(result.scrubbed).toBe(true);
    expect(result.removed).toHaveLength(7);
    const after = JSON.parse(io.files[CONFIG_PATH]!);
    expect(plaintextSecretsPresent(after)).toEqual([]);
    // non-secret settings preserved
    expect(after.language).toBe("en");
    expect(after.openaiCompat.model).toBe("fixture-model");
    // env (the authoritative copy) untouched
    expect(env.XAI_API_KEY).toBe(FIX.xai);
    expect(io.writes).toBe(1);
  });

  it("no-op when config.json has no secrets or is absent", () => {
    const io = memoryIo({ [CONFIG_PATH]: JSON.stringify({ language: "en" }) });
    expect(
      scrubPlaintextSecretsAtBoot({ dataDir: "/fixture/.danibot", store: headless, env: {}, io, onWarning }).scrubbed,
    ).toBe(false);
    expect(io.writes).toBe(0);
    const missing = memoryIo({});
    expect(
      scrubPlaintextSecretsAtBoot({ dataDir: "/fixture/.danibot", store: headless, env: {}, io: missing, onWarning })
        .scrubbed,
    ).toBe(false);
  });

  it("headless fail-closed: refuses to boot on uncovered plaintext (file untouched)", () => {
    const before = JSON.stringify(plaintextConfig());
    const io = memoryIo({ [CONFIG_PATH]: before });
    expect(() =>
      scrubPlaintextSecretsAtBoot({ dataDir: "/fixture/.danibot", store: headless, env: {}, io, onWarning }),
    ).toThrow(/refusing to boot/);
    expect(io.files[CONFIG_PATH]).toBe(before);
    expect(io.writes).toBe(0);
  });

  it("headless fail-closed: refuses boot when only SOME secrets are covered", () => {
    const io = memoryIo({ [CONFIG_PATH]: JSON.stringify(plaintextConfig()) });
    expect(() =>
      scrubPlaintextSecretsAtBoot({
        dataDir: "/fixture/.danibot",
        store: headless,
        env: { XAI_API_KEY: FIX.xai },
        io,
        onWarning,
      }),
    ).toThrow(/box\.token/);
    expect(io.writes).toBe(0);
  });

  it("keychain unavailable (desktop): leaves uncovered plaintext in place with a loud warning", () => {
    const before = JSON.stringify(plaintextConfig());
    const io = memoryIo({ [CONFIG_PATH]: before });
    // keychain unreadable this launch: shell injected nothing, store empty
    const result = scrubPlaintextSecretsAtBoot({
      dataDir: "/fixture/.danibot",
      store: desktop,
      env: {},
      io,
      onWarning,
    });
    expect(result.scrubbed).toBe(false);
    expect(io.files[CONFIG_PATH]).toBe(before);
    expect(warnings.join("\n")).toMatch(/unavailable|later launch/i);
  });

  it("desktop: scrubs covered secrets, leaves uncovered ones for the next launch", () => {
    const io = memoryIo({ [CONFIG_PATH]: JSON.stringify(plaintextConfig()) });
    const result = scrubPlaintextSecretsAtBoot({
      dataDir: "/fixture/.danibot",
      store: desktop,
      env: { XAI_API_KEY: FIX.xai, BOX_TOKEN: FIX.box },
      io,
      onWarning,
    });
    expect(result.scrubbed).toBe(true);
    expect(result.removed.sort()).toEqual(["box.token", "xai.key"]);
    const after = JSON.parse(io.files[CONFIG_PATH]!);
    expect(plaintextSecretsPresent(after)).toContain("composio.apiKey");
    expect(plaintextSecretsPresent(after)).not.toContain("xai.key");
  });

  it("interrupted write: file bytes unchanged, error propagates, nothing partial", () => {
    const before = JSON.stringify(plaintextConfig());
    const io = memoryIo({ [CONFIG_PATH]: before }, { failWrite: true });
    expect(() =>
      scrubPlaintextSecretsAtBoot({
        dataDir: "/fixture/.danibot",
        store: headless,
        env: coveredEnv(),
        io,
        onWarning,
      }),
    ).toThrow(/simulated interrupted write/);
    expect(io.files[CONFIG_PATH]).toBe(before);
  });

  it("rollback: failed verification throws without reintroducing plaintext", () => {
    const before = JSON.stringify(plaintextConfig());
    const io = memoryIo({ [CONFIG_PATH]: before });
    // corrupt the post-write read so verification sees the secrets again
    const realRead = io.readFile;
    let reads = 0;
    io.readFile = (path: string) => {
      reads += 1;
      return reads === 1 ? realRead(path) : before;
    };
    expect(() =>
      scrubPlaintextSecretsAtBoot({
        dataDir: "/fixture/.danibot",
        store: headless,
        env: coveredEnv(),
        io,
        onWarning,
      }),
    ).toThrow(/verification failed/);
    // exactly one write attempt: no restore-from-backup that could put
    // plaintext back on disk
    expect(io.writes).toBe(1);
  });

  it("end-to-end: real-fs atomic scrub in an isolated fixture dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-secrets-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify(plaintextConfig()));
      const result = scrubPlaintextSecretsAtBoot({
        dataDir: dir,
        store: headless,
        env: coveredEnv(),
        io: nodeSecretStoreIo,
        onWarning: () => {},
      });
      expect(result.scrubbed).toBe(true);
      expect(result.removed).toHaveLength(7);
      const after = JSON.parse(readFileSync(configPath, "utf8"));
      expect(plaintextSecretsPresent(after)).toEqual([]);
      expect(after.language).toBe("en");
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("insecure local-dev mode: leaves plaintext in place with a warning", () => {
    const before = JSON.stringify(plaintextConfig());
    const io = memoryIo({ [CONFIG_PATH]: before });
    const store = resolveSecretStore({ DANI_INSECURE_LOCAL_DEV: "1" }, "/fixture/.danibot");
    const result = scrubPlaintextSecretsAtBoot({ dataDir: "/fixture/.danibot", store, env: {}, io, onWarning });
    expect(result.scrubbed).toBe(false);
    expect(io.files[CONFIG_PATH]).toBe(before);
    expect(warnings.join("\n")).toContain("INSECURE LOCAL DEVELOPMENT MODE");
  });
});

describe("importFdInjectedSecrets", () => {
  it("reads secrets from file descriptors into env and removes the _FD marker", () => {
    const io = memoryIo({});
    io.readFdImpl = (fd: number) => ({ 3: `${FIX.xai}\n`, 4: FIX.box }[fd] ?? "");
    const env: NodeJS.ProcessEnv = { XAI_API_KEY_FD: "3", BOX_TOKEN_FD: "4" };
    const injected = importFdInjectedSecrets(env, io);
    expect(injected.sort()).toEqual(["BOX_TOKEN", "XAI_API_KEY"]);
    expect(env.XAI_API_KEY).toBe(FIX.xai);
    expect(env.BOX_TOKEN).toBe(FIX.box);
    expect("XAI_API_KEY_FD" in env).toBe(false);
    expect("BOX_TOKEN_FD" in env).toBe(false);
  });

  it("fails closed on an invalid fd", () => {
    const io = memoryIo({});
    expect(() => importFdInjectedSecrets({ XAI_API_KEY_FD: "banana" }, io)).toThrow(/not a valid file descriptor/);
  });

  it("fails closed when the fd cannot be read or is empty", () => {
    const io = memoryIo({});
    expect(() => importFdInjectedSecrets({ XAI_API_KEY_FD: "9" }, io)).toThrow(/could not read/);
    const empty = memoryIo({});
    empty.readFdImpl = () => "  \n";
    expect(() => importFdInjectedSecrets({ BOX_TOKEN_FD: "9" }, empty)).toThrow(/empty secret/);
  });
});

describe("applySecretAwareConfigSave", () => {
  it("headless fail-closed: persists non-secrets, refuses secret fields", () => {
    const saved: Array<Record<string, unknown>> = [];
    const result = applySecretAwareConfigSave({
      patch: { xai: { key: FIX.xai }, language: "en", profile: { name: "Fixture" } },
      store: headless,
      externalSecretStorage: false,
      saveConfig: (patch) => saved.push(patch),
      onWarning: () => {},
    });
    expect(result.refused).toEqual(["xai.key"]);
    expect(saved).toHaveLength(1);
    const persisted = JSON.parse(JSON.stringify(saved[0]));
    expect(persisted.language).toBe("en");
    expect(persisted.profile).toEqual({ name: "Fixture" });
    expect(Object.hasOwn(persisted.xai ?? {}, "key")).toBe(false);
    // the refused secret never reaches process env either
    expect(result.envPatch).toEqual(persisted);
    expect(refusedSecretsMessage(result.refused)).toMatch(/XAI_API_KEY/);
    expect(refusedSecretsMessage(result.refused)).toMatch(/DANI_INSECURE_LOCAL_DEV/);
  });

  it("headless: pure non-secret patches save untouched", () => {
    const saved: Array<Record<string, unknown>> = [];
    const result = applySecretAwareConfigSave({
      patch: { language: "en" },
      store: headless,
      externalSecretStorage: false,
      saveConfig: (patch) => saved.push(patch),
      onWarning: () => {},
    });
    expect(result.refused).toEqual([]);
    expect(saved[0]).toEqual({ language: "en" });
  });

  it("desktop without the shell commit flag fails closed before any save", () => {
    const saveConfig = vi.fn();
    expect(() =>
      applySecretAwareConfigSave({
        patch: { xai: { key: FIX.xai } },
        store: desktop,
        externalSecretStorage: false,
        saveConfig,
        onWarning: () => {},
      }),
    ).toThrow(/did not come through the desktop shell/);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("desktop with the shell commit flag: tombstones secrets, keeps real values in env", () => {
    const saved: Array<Record<string, unknown>> = [];
    const result = applySecretAwareConfigSave({
      patch: { xai: { key: FIX.xai }, language: "en" },
      store: desktop,
      externalSecretStorage: true,
      saveConfig: (patch) => saved.push(patch),
      onWarning: () => {},
    });
    expect(result.refused).toEqual([]);
    expect((saved[0]!.xai as Record<string, unknown>).key).toBe("");
    expect((result.envPatch.xai as Record<string, unknown>).key).toBe(FIX.xai);
  });

  it("insecure local-dev: legacy plaintext save with a loud warning", () => {
    const warnings: string[] = [];
    const saved: Array<Record<string, unknown>> = [];
    const store = resolveSecretStore({ DANI_INSECURE_LOCAL_DEV: "1" }, "/fixture/.danibot");
    const result = applySecretAwareConfigSave({
      patch: { xai: { key: FIX.xai } },
      store,
      externalSecretStorage: false,
      saveConfig: (patch) => saved.push(patch),
      onWarning: (message) => warnings.push(message),
    });
    expect(result.refused).toEqual([]);
    expect((saved[0]!.xai as Record<string, unknown>).key).toBe(FIX.xai);
    expect(warnings.join("\n")).toContain("INSECURE LOCAL DEVELOPMENT MODE");
  });

  it("secretLabelsInPatch detects touched secret fields", () => {
    expect(secretLabelsInPatch({ box: { token: "" }, language: "en" })).toEqual(["box.token"]);
    expect(secretLabelsInPatch({ language: "en" })).toEqual([]);
  });
});
