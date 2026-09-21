// Upgrade install contract (spec 080): an existing data directory must
// survive an upgrade with its data preserved, and every write that migrates
// persisted state leaves a one-time backup of the pre-migration file. These
// tests seed a real legacy-shaped data directory on the filesystem and run
// the real hydration/save paths — no stubs.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, loadConfig, saveConfig } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

/** Seed config.json + bots.json the way #567-era builds persisted them:
 * mixed-case/duplicate browser profile ids, bots referencing legacy ids. */
function seedLegacyDataDir() {
  const store = new Store(selection);
  const bot = store.createBot();
  const configFile = join(DATA_DIR, "config.json");
  const botsFile = join(DATA_DIR, "bots.json");
  const legacyConfig = {
    browserProfiles: [
      { id: "Work", name: "Primary" },
      { id: "Work", name: "Duplicate" },
      { id: "work", name: "Lowercase variant" },
    ],
  };
  writeFileSync(configFile, JSON.stringify(legacyConfig));
  const legacyBots: BotRecord[] = JSON.parse(readFileSync(botsFile, "utf8"));
  legacyBots.find((candidate) => candidate.id === bot.id)!.browserProfile = "Work";
  writeFileSync(botsFile, JSON.stringify(legacyBots));
  return { bot, configFile, botsFile, legacyConfig, legacyBots };
}

describe("upgrade migration backup", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("hydration preserves data, migrates bots.json, and leaves a pre-migration backup", () => {
    const { bot, botsFile, legacyBots } = seedLegacyDataDir();

    const upgraded = new Store(selection);
    // Data preserved: the bot survives with a canonical profile reference.
    expect(upgraded.bot(bot.id)?.browserProfile).toBe("work-2");
    expect(upgraded.bot(bot.id)?.name).toBe(bot.name);
    const persisted: BotRecord[] = JSON.parse(readFileSync(botsFile, "utf8"));
    expect(persisted.find((candidate) => candidate.id === bot.id)?.browserProfile).toBe("work-2");

    // The backup holds the exact pre-migration bytes, and the read path is
    // unchanged: loadConfig still migrates legacy config tolerantly.
    const backupFile = `${botsFile}.pre-migration-backup`;
    expect(existsSync(backupFile)).toBe(true);
    expect(JSON.parse(readFileSync(backupFile, "utf8"))).toEqual(legacyBots);
    expect(loadConfig().browserProfiles?.map((profile) => profile.id)).toEqual(["work-2", "work-3", "work"]);
  });

  it("a settings save migrates config.json and leaves a pre-migration backup", () => {
    const { configFile, legacyConfig } = seedLegacyDataDir();
    // Hydrate once so bots.json migrates first, as on a real upgrade boot.
    new Store(selection);

    saveConfig({});
    const migrated = JSON.parse(readFileSync(configFile, "utf8"));
    expect(migrated.browserProfiles.map((profile: { id: string }) => profile.id)).toEqual(["work-2", "work-3", "work"]);

    const backupFile = `${configFile}.pre-migration-backup`;
    expect(existsSync(backupFile)).toBe(true);
    expect(JSON.parse(readFileSync(backupFile, "utf8"))).toEqual(legacyConfig);
  });

  it("never overwrites the original pre-migration backups on later writes", () => {
    const { configFile, botsFile, legacyConfig, legacyBots } = seedLegacyDataDir();
    new Store(selection);
    saveConfig({});
    // Later boots and saves touch already-migrated files; the backups of the
    // true pre-upgrade originals must survive untouched.
    new Store(selection);
    saveConfig({});
    expect(JSON.parse(readFileSync(`${botsFile}.pre-migration-backup`, "utf8"))).toEqual(legacyBots);
    expect(JSON.parse(readFileSync(`${configFile}.pre-migration-backup`, "utf8"))).toEqual(legacyConfig);
  });

  it("writes no backup when nothing is legacy", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const configFile = join(DATA_DIR, "config.json");
    const botsFile = join(DATA_DIR, "bots.json");
    writeFileSync(configFile, JSON.stringify({ browserProfiles: [{ id: "work", name: "Canonical" }] }));
    // A plain restart rewrite (busy reset) is not an upgrade migration.
    new Store(selection);
    saveConfig({});
    expect(existsSync(`${botsFile}.pre-migration-backup`)).toBe(false);
    expect(existsSync(`${configFile}.pre-migration-backup`)).toBe(false);
    expect(store.bot(bot.id)?.name).toBe(bot.name);
  });
});
