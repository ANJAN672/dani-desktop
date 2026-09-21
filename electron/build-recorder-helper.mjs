// Build the global-input observer as a real macOS app bundle. A stable bundle
// identity is required for Accessibility/Input Monitoring consent to persist.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(electronDir);
const resourcesDir = path.join(electronDir, "resources");

export const recorderHelperBundle = path.join(resourcesDir, "Dani Bot Recorder.app");
export const recorderHelperBinary = path.join(recorderHelperBundle, "Contents", "MacOS", "recorder-helper");

export function buildRecorderHelper() {
  // Rebuild from a clean bundle so stale signatures or resources cannot leak
  // into the helper that is shipped with the desktop app.
  rmSync(recorderHelperBundle, { recursive: true, force: true });
  const contents = path.join(recorderHelperBundle, "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  copyFileSync(path.join(resourcesDir, "recorder-helper-Info.plist"), path.join(contents, "Info.plist"));

  const temporaryDir = mkdtempSync(path.join(os.tmpdir(), "dani-recorder-helper-"));
  try {
    const slices = ["arm64", "x86_64"].map((arch) => {
      const slice = path.join(temporaryDir, `recorder-helper-${arch}`);
      execFileSync(
        "swiftc",
        ["-O", "-target", `${arch}-apple-macos12`, path.join(resourcesDir, "recorder-helper.swift"), "-o", slice],
        { stdio: "inherit", timeout: 120_000 },
      );
      return slice;
    });
    execFileSync("lipo", ["-create", ...slices, "-output", recorderHelperBinary], {
      stdio: "inherit",
      timeout: 60_000,
    });

    const archs = execFileSync("lipo", ["-archs", recorderHelperBinary], { timeout: 60_000 })
      .toString()
      .trim()
      .split(/\s+/);
    const requiredArchs = ["arm64", "x86_64"];
    if (!requiredArchs.every((arch) => archs.includes(arch))) {
      throw new Error(`recorder helper is not universal: ${archs.join(" ")}`);
    }

    // Give development builds a stable identity and hardened-runtime signing;
    // electron-builder replaces the ad-hoc signature for distribution builds.
    execFileSync(
      "codesign",
      [
        "--force",
        "--deep",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--entitlements",
        path.join(projectDir, "build", "entitlements.mac.plist"),
        recorderHelperBundle,
      ],
      { stdio: "inherit", timeout: 30_000 },
    );
    execFileSync("codesign", ["--verify", "--strict", "--verbose=2", recorderHelperBundle], {
      stdio: "inherit",
      timeout: 30_000,
    });
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildRecorderHelper();
}
