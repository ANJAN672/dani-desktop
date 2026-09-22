import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectStaging, inspectTarget, TARGETS } from "./prepare-hermes-payload.mjs";

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function stagingDir() {
  const dir = mkdtempSync(join(tmpdir(), "hermes-staging-"));
  dirs.push(dir);
  return dir;
}

function stage(dir, target, { corruptDigest = false, wrongSize = false, manifestTarget = target } = {}) {
  const archive = Buffer.from(`archive for ${target}`);
  writeFileSync(join(dir, `${target}.tar.gz`), archive);
  writeFileSync(
    join(dir, `${target}.manifest.json`),
    JSON.stringify({
      manifestVersion: 1,
      target: manifestTarget,
      version: "0.21.4",
      archiveSha256: corruptDigest ? "0".repeat(64) : createHash("sha256").update(archive).digest("hex"),
      archiveSize: wrongSize ? archive.length + 1 : archive.length,
      format: "tar.gz",
      executableRelPath: "bin/hermes-acp",
    }),
  );
}

describe("hermes payload staging", () => {
  it("treats an empty staging directory as a valid, honest state", () => {
    const report = inspectStaging(stagingDir());
    expect(report).toHaveLength(TARGETS.length);
    expect(report.every((entry) => entry.state === "absent")).toBe(true);
  });

  it("accepts a payload that matches its manifest", () => {
    const dir = stagingDir();
    stage(dir, "linux-x64");
    expect(inspectTarget(dir, "linux-x64")).toMatchObject({ state: "staged", version: "0.21.4" });
  });

  it("refuses bytes the app would reject at first run", () => {
    const dir = stagingDir();
    stage(dir, "linux-x64", { corruptDigest: true });
    expect(inspectTarget(dir, "linux-x64")).toMatchObject({ state: "invalid", reason: /digest/ });
  });

  it("refuses a size that disagrees with the archive", () => {
    const dir = stagingDir();
    stage(dir, "win-x64", { wrongSize: true });
    expect(inspectTarget(dir, "win-x64")).toMatchObject({ state: "invalid", reason: /size/ });
  });

  it("refuses a manifest staged under the wrong target name", () => {
    const dir = stagingDir();
    stage(dir, "mac-arm64", { manifestTarget: "mac-x64" });
    expect(inspectTarget(dir, "mac-arm64")).toMatchObject({ state: "invalid", reason: /different target/ });
  });

  it("refuses half a payload in either direction", () => {
    const orphanArchive = stagingDir();
    writeFileSync(join(orphanArchive, "linux-x64.tar.gz"), "bytes");
    expect(inspectTarget(orphanArchive, "linux-x64")).toMatchObject({ state: "invalid", reason: /without a manifest/ });

    const orphanManifest = stagingDir();
    writeFileSync(join(orphanManifest, "linux-x64.manifest.json"), "{}");
    expect(inspectTarget(orphanManifest, "linux-x64")).toMatchObject({ state: "invalid", reason: /without an archive/ });
  });

  it("refuses an unreadable manifest and an unsupported schema version", () => {
    const broken = stagingDir();
    writeFileSync(join(broken, "linux-x64.tar.gz"), "bytes");
    writeFileSync(join(broken, "linux-x64.manifest.json"), "not json");
    expect(inspectTarget(broken, "linux-x64")).toMatchObject({ state: "invalid", reason: /valid JSON/ });

    const future = stagingDir();
    writeFileSync(join(future, "win-x64.tar.gz"), "bytes");
    writeFileSync(join(future, "win-x64.manifest.json"), JSON.stringify({ manifestVersion: 2, target: "win-x64" }));
    expect(inspectTarget(future, "win-x64")).toMatchObject({ state: "invalid", reason: /manifest version/ });
  });

  it("reports each published target independently", () => {
    const dir = stagingDir();
    stage(dir, "linux-x64");
    stage(dir, "win-x64", { corruptDigest: true });
    const byTarget = Object.fromEntries(inspectStaging(dir).map((entry) => [entry.target, entry.state]));
    expect(byTarget).toMatchObject({ "linux-x64": "staged", "win-x64": "invalid", "mac-arm64": "absent", "mac-x64": "absent" });
  });
});
