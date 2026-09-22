// The validation list issue #18 names for this service: manifest parsing,
// platform selection, hash mismatch, archive traversal rejection, interrupted
// activation, lock contention, rollback and repair.
//
// The archives here are built in the test, from real gzip and real tar bytes.
// They exercise the extractor, not a stand-in for it, and none of them is a
// stand-in for a Hermes runtime or evidence that one works.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";
import {
  activateBundledRuntime,
  extractTarGz,
  HermesRuntimeError,
  installedRuntime,
  parseManifest,
  safeMemberPath,
  selectTarget,
  type HermesManifest,
} from "./hermes-runtime.ts";

const TAR_BLOCK = 512;
const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length) await removeTempDir(dirs.pop()!);
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hermes-${label}-`));
  dirs.push(dir);
  return dir;
}

interface Member {
  name: string;
  body?: string;
  /** tar typeflag: "0" file, "5" directory, "2" symlink. */
  type?: string;
  linkTarget?: string;
  mode?: number;
  /** Corrupt the header checksum on purpose. */
  breakChecksum?: boolean;
}

/** Build a real ustar archive so the extractor parses genuine bytes. */
function tar(members: Member[], options: { omitEndMarker?: boolean; trailing?: Buffer } = {}): Buffer {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const body = Buffer.from(member.body ?? "", "utf8");
    const header = Buffer.alloc(TAR_BLOCK);
    header.write(member.name, 0, 100, "utf8");
    header.write((member.mode ?? 0o644).toString(8).padStart(7, "0") + "\0", 100, 8, "utf8");
    header.write("0000000\0", 108, 8, "utf8");
    header.write("0000000\0", 116, 8, "utf8");
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");
    header.write("00000000000\0", 136, 12, "utf8");
    header.write(member.type ?? "0", 156, 1, "utf8");
    if (member.linkTarget) header.write(member.linkTarget, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");

    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    if (member.breakChecksum) sum += 1;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");

    blocks.push(header);
    if (body.length > 0) {
      const padded = Buffer.alloc(Math.ceil(body.length / TAR_BLOCK) * TAR_BLOCK);
      body.copy(padded);
      blocks.push(padded);
    }
  }
  if (!options.omitEndMarker) blocks.push(Buffer.alloc(TAR_BLOCK * 2));
  if (options.trailing) blocks.push(options.trailing);
  return Buffer.concat(blocks);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Write a payload directory the activator can read, and return its manifest. */
function payload(
  members: Member[] = [{ name: "bin/hermes-acp", body: "#!/bin/sh\n", mode: 0o755 }],
  overrides: Partial<HermesManifest> = {},
  tarOptions: Parameters<typeof tar>[1] = {},
): { dir: string; manifest: HermesManifest; archive: Buffer } {
  const dir = tempDir("payload");
  const archive = gzipSync(tar(members, tarOptions));
  writeFileSync(join(dir, "linux-x64.tar.gz"), archive);
  const manifest: HermesManifest = {
    manifestVersion: 1,
    name: "hermes-runtime-payload",
    target: "linux-x64",
    version: "0.21.4",
    archiveSha256: sha256(archive),
    archiveSize: archive.length,
    unpackedSize: 4096,
    format: "tar.gz",
    executableRelPath: "bin/hermes-acp",
    degradations: [],
    ...overrides,
  };
  writeFileSync(join(dir, "linux-x64.manifest.json"), JSON.stringify(manifest));
  return { dir, manifest, archive };
}

const activate = (dir: string, dataDir: string, suffix?: string) =>
  activateBundledRuntime({ payloadDir: dir, dataDir, target: "linux-x64", stagingSuffix: suffix });

describe("platform selection", () => {
  it("maps each published target", () => {
    expect(selectTarget("linux", "x64")).toBe("linux-x64");
    expect(selectTarget("win32", "x64")).toBe("win-x64");
    expect(selectTarget("darwin", "arm64")).toBe("mac-arm64");
    expect(selectTarget("darwin", "x64")).toBe("mac-x64");
  });

  it("returns null where nothing is published rather than guessing", () => {
    expect(selectTarget("linux", "arm64")).toBeNull();
    expect(selectTarget("win32", "arm64")).toBeNull();
    expect(selectTarget("freebsd" as NodeJS.Platform, "x64")).toBeNull();
  });
});

describe("manifest parsing", () => {
  const base = payload().manifest;

  it("accepts the shipped schema", () => {
    expect(parseManifest({ ...base })).toMatchObject({ target: "linux-x64", version: "0.21.4" });
  });

  it("refuses a manifest version this code does not implement", () => {
    expect(() => parseManifest({ ...base, manifestVersion: 2 })).toThrow(/unsupported manifestVersion/);
  });

  it("refuses a digest that is not 64 lowercase hex characters", () => {
    expect(() => parseManifest({ ...base, archiveSha256: "ABC" })).toThrow(/archiveSha256/);
    expect(() => parseManifest({ ...base, archiveSha256: base.archiveSha256.toUpperCase() })).toThrow(/archiveSha256/);
  });

  it("refuses non-positive or fractional sizes", () => {
    expect(() => parseManifest({ ...base, archiveSize: 0 })).toThrow(/archiveSize/);
    expect(() => parseManifest({ ...base, unpackedSize: 1.5 })).toThrow(/unpackedSize/);
  });

  it("refuses an unknown target, a foreign format and a junk value", () => {
    expect(() => parseManifest({ ...base, target: "solaris-sparc" })).toThrow(/unknown target/);
    expect(() => parseManifest({ ...base, format: "zip" })).toThrow(/unsupported format/);
    expect(() => parseManifest(null)).toThrow(/not an object/);
    expect(() => parseManifest([base])).toThrow(/not an object/);
  });

  it("holds executableRelPath to the archive-member rules", () => {
    expect(() => parseManifest({ ...base, executableRelPath: "../escape" })).toThrow(/parent traversal/);
    expect(() => parseManifest({ ...base, executableRelPath: "/etc/passwd" })).toThrow(/absolute/);
  });
});

describe("archive path safety", () => {
  it("rejects every escape shape", () => {
    for (const name of ["/etc/passwd", "../up", "a/../../up", "C:\\win", "back\\slash", "a\0b", "", "."]) {
      expect(() => safeMemberPath(name), name).toThrow(HermesRuntimeError);
    }
  });

  it("accepts an ordinary nested path", () => {
    expect(safeMemberPath("bin/hermes-acp")).toBe("bin/hermes-acp");
    expect(safeMemberPath("lib/python3.11/site-packages/x.py")).toBe("lib/python3.11/site-packages/x.py");
  });
});

describe("extraction", () => {
  it("writes files and directories from a real archive", async () => {
    const dir = tempDir("archive");
    const out = tempDir("out");
    const archive = join(dir, "a.tar.gz");
    writeFileSync(archive, gzipSync(tar([
      { name: "bin", type: "5" },
      { name: "bin/hermes-acp", body: "run me", mode: 0o755 },
      { name: "NOTICE", body: "terms" },
    ])));
    const result = await extractTarGz(archive, out, 1 << 20);
    expect(result.files).toBe(2);
    expect(readFileSync(join(out, "bin", "hermes-acp"), "utf8")).toBe("run me");
    expect(readFileSync(join(out, "NOTICE"), "utf8")).toBe("terms");
  });

  it("refuses a member that would escape the destination", async () => {
    const dir = tempDir("archive");
    const out = tempDir("out");
    const archive = join(dir, "evil.tar.gz");
    writeFileSync(archive, gzipSync(tar([{ name: "../escaped", body: "pwned" }])));
    await expect(extractTarGz(archive, out, 1 << 20)).rejects.toThrow(/parent traversal/);
    expect(existsSync(join(out, "..", "escaped"))).toBe(false);
  });

  it("refuses symlinks, which are the other way out of the directory", async () => {
    const dir = tempDir("archive");
    const archive = join(dir, "link.tar.gz");
    writeFileSync(archive, gzipSync(tar([{ name: "link", type: "2", linkTarget: "/etc/passwd" }])));
    await expect(extractTarGz(archive, tempDir("out"), 1 << 20)).rejects.toThrow(/links are not allowed/);
  });

  it("refuses a corrupt header checksum", async () => {
    const dir = tempDir("archive");
    const archive = join(dir, "bad.tar.gz");
    writeFileSync(archive, gzipSync(tar([{ name: "f", body: "x", breakChecksum: true }])));
    await expect(extractTarGz(archive, tempDir("out"), 1 << 20)).rejects.toThrow(/checksum/);
  });

  it("refuses an archive with no end marker, and data past the end", async () => {
    const dir = tempDir("archive");
    const truncated = join(dir, "t.tar.gz");
    writeFileSync(truncated, gzipSync(tar([{ name: "f", body: "x" }], { omitEndMarker: true })));
    await expect(extractTarGz(truncated, tempDir("out"), 1 << 20)).rejects.toThrow(/end-of-archive/);

    const trailing = join(dir, "x.tar.gz");
    writeFileSync(trailing, gzipSync(tar([{ name: "f", body: "x" }], { trailing: Buffer.alloc(TAR_BLOCK, 0x41) })));
    await expect(extractTarGz(trailing, tempDir("out"), 1 << 20)).rejects.toThrow(/after the end/);
  });

  it("stops at the size budget instead of filling the disk", async () => {
    const dir = tempDir("archive");
    const archive = join(dir, "big.tar.gz");
    writeFileSync(archive, gzipSync(tar([{ name: "big", body: "x".repeat(50_000) }])));
    await expect(extractTarGz(archive, tempDir("out"), 1_000)).rejects.toThrow(/expands beyond/);
  });

  it("splits a member across stream chunks without corrupting it", async () => {
    const dir = tempDir("archive");
    const out = tempDir("out");
    const archive = join(dir, "chunky.tar.gz");
    // Comfortably larger than one gunzip output chunk, so the writable sink
    // has to carry state between calls.
    const body = "abcdefghij".repeat(80_000);
    writeFileSync(archive, gzipSync(tar([{ name: "bin/big", body }, { name: "after", body: "tail" }])));
    await extractTarGz(archive, out, 1 << 24);
    expect(readFileSync(join(out, "bin", "big"), "utf8")).toBe(body);
    expect(readFileSync(join(out, "after"), "utf8")).toBe("tail");
  });
});

describe("activation", () => {
  it("verifies, extracts and activates, then reuses the install", async () => {
    const { dir, manifest } = payload();
    const dataDir = tempDir("data");

    const layout = await activate(dir, dataDir);
    expect(layout.digest).toBe(manifest.archiveSha256);
    expect(existsSync(layout.executable)).toBe(true);
    expect(await installedRuntime(dataDir, manifest)).not.toBeNull();

    // Second call must not re-extract; the same activated directory comes back.
    expect((await activate(dir, dataDir)).versionDir).toBe(layout.versionDir);
  });

  it("fails closed on a digest mismatch and activates nothing", async () => {
    const { dir, manifest } = payload(undefined, { archiveSha256: "b".repeat(64) });
    const dataDir = tempDir("data");
    await expect(activate(dir, dataDir)).rejects.toMatchObject({ code: "runtime.digest-mismatch" });
    expect(await installedRuntime(dataDir, manifest)).toBeNull();
  });

  it("fails closed when the recorded size disagrees with the file", async () => {
    const { dir } = payload(undefined, { archiveSize: 999_999 });
    await expect(activate(dir, tempDir("data"))).rejects.toMatchObject({ code: "runtime.digest-mismatch" });
  });

  it("reports a missing payload as such rather than as corruption", async () => {
    await expect(activate(tempDir("empty"), tempDir("data"))).rejects.toMatchObject({ code: "runtime.payload-missing" });
  });

  it("refuses a payload whose manifest describes another system", async () => {
    const { dir } = payload(undefined, { target: "win-x64" });
    await expect(activate(dir, tempDir("data"))).rejects.toMatchObject({ code: "runtime.manifest-invalid" });
  });

  it("refuses an archive that does not contain the promised executable", async () => {
    const { dir, manifest } = payload([{ name: "NOTICE", body: "terms" }]);
    const dataDir = tempDir("data");
    await expect(activate(dir, dataDir)).rejects.toMatchObject({ code: "runtime.executable-missing" });
    expect(await installedRuntime(dataDir, manifest)).toBeNull();
  });

  it("leaves no staging directory behind when activation fails", async () => {
    const { dir } = payload([{ name: "NOTICE", body: "terms" }]);
    const dataDir = tempDir("data");
    await expect(activate(dir, dataDir)).rejects.toThrow();
    const versions = join(dataDir, "runtimes", "hermes", "versions");
    // A partially extracted tree must not survive under any name. Anything
    // left here would later be mistaken for a runtime.
    const leftovers = existsSync(versions) ? readdirSync(versions) : [];
    expect(leftovers).toEqual([]);
  });

  it("keeps the previously activated runtime when a later activation fails", async () => {
    const dataDir = tempDir("data");
    const good = payload();
    const layout = await activate(good.dir, dataDir);
    expect(existsSync(layout.executable)).toBe(true);

    const broken = payload([{ name: "NOTICE", body: "terms" }]);
    await expect(activate(broken.dir, dataDir)).rejects.toThrow();

    // The rollback requirement: the last verified runtime is still serving.
    expect(existsSync(layout.executable)).toBe(true);
    expect(await installedRuntime(dataDir, good.manifest)).not.toBeNull();
  });

  it("treats an interrupted activation as absent and repairs on the next run", async () => {
    const { dir, manifest } = payload();
    const dataDir = tempDir("data");
    const layout = await activate(dir, dataDir);

    // Simulate a crash between extraction and the completion record.
    const { rmSync } = await import("node:fs");
    rmSync(join(layout.versionDir, ".install-complete.json"));
    expect(await installedRuntime(dataDir, manifest)).toBeNull();

    // Repair is just activating again, and it must succeed rather than trip
    // over the partial directory it finds.
    const repaired = await activate(dir, dataDir);
    expect(existsSync(repaired.executable)).toBe(true);
    expect(await installedRuntime(dataDir, manifest)).not.toBeNull();
  });

  it("treats a completed record with a missing executable as absent", async () => {
    const { dir, manifest } = payload();
    const dataDir = tempDir("data");
    const layout = await activate(dir, dataDir);
    const { rmSync } = await import("node:fs");
    rmSync(layout.executable);
    expect(await installedRuntime(dataDir, manifest)).toBeNull();
  });

  it("joins concurrent activations instead of racing them", async () => {
    const { dir } = payload();
    const dataDir = tempDir("data");
    const [a, b, c] = await Promise.all([activate(dir, dataDir), activate(dir, dataDir), activate(dir, dataDir)]);
    expect(a.versionDir).toBe(b.versionDir);
    expect(b.versionDir).toBe(c.versionDir);
    expect(existsSync(a.executable)).toBe(true);
  });

  it("surfaces the same failure to every waiter on a contended activation", async () => {
    const { dir } = payload(undefined, { archiveSha256: "c".repeat(64) });
    const dataDir = tempDir("data");
    const results = await Promise.allSettled([activate(dir, dataDir), activate(dir, dataDir)]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });

  it("activates into a directory named for the digest, not a guessable path", async () => {
    const { dir, manifest } = payload();
    const dataDir = tempDir("data");
    const layout = await activate(dir, dataDir);
    expect(layout.versionDir.endsWith(manifest.archiveSha256)).toBe(true);
  });
});
