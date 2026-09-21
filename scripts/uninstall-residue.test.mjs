import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Spec 080 R6: uninstall leaves no residue beyond the documented data
// directory. The README's uninstall section is the contract users read; the
// paths it lists must be the paths the code actually writes, and the
// installer/uninstaller behaviors it claims must be configured. Docs and
// code cannot drift.

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const readme = read("../README.md");
const mainMjs = read("../electron/main.mjs");
const configTs = read("../server/config.ts");
const builderYml = read("../electron-builder.yml");
const afterInstall = read("../build/linux-after-install.sh");

describe("spec 080 R6 uninstall residue contract", () => {
  it("documents an uninstall section whose data directory is the server's real one", () => {
    expect(readme).toContain("## Uninstall");
    // the documented remainder is the code's DATA_DIR default
    expect(configTs).toContain('join(homedir(), ".danibot")');
    expect(readme).toContain("~/.danibot");
  });

  it("legacy data homes are moved into the data dir, and the README says where strays come from", () => {
    expect(configTs).toContain('join(homedir(), ".openmausbot")');
    expect(configTs).toContain('join(homedir(), ".opengrokbot")');
    // rename (move), never copy: a migrated install has no second residue dir
    expect(configTs).toMatch(/renameSync\(legacy, DATA_DIR\)/);
    expect(readme).toContain("~/.openmausbot");
    expect(readme).toContain("~/.opengrokbot");
  });

  it("the app-support and log paths the README names are the ones Electron pins", () => {
    expect(mainMjs).toContain('app.setPath("userData", path.join(app.getPath("appData"), "Dani Bot"))');
    expect(mainMjs).toContain('path.join(app.getPath("home"), "Library", "Logs", "Dani Bot")');
    expect(readme).toContain('$HOME/Library/Application Support/Dani Bot');
    expect(readme).toContain('$HOME/Library/Logs/Dani Bot');
    expect(readme).toContain("%APPDATA%\\Dani Bot");
    expect(readme).toContain('$HOME/.config/Dani Bot');
  });

  it("the Windows uninstaller is configured to delete app data", () => {
    expect(builderYml).toMatch(/deleteAppDataOnUninstall:\s*true/);
  });

  it("deb package-level extras installed outside dpkg's manifest get removed by the default after-remove", () => {
    // the after-install hook installs these outside the package manifest
    expect(afterInstall).toContain("update-alternatives --install");
    expect(afterInstall).toContain("/etc/apparmor.d");
    // electron-builder's default after-remove template removes both; a custom
    // after-remove override would shadow it, so none may appear
    expect(builderYml).not.toMatch(/afterRemove:/);
  });
});
