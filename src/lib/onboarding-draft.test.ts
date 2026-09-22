import { describe, expect, it } from "vitest";
import { clearDraft, EMPTY_DRAFT, readDraft, writeDraft } from "./onboarding-draft";

/** A minimal Storage that can be told to misbehave the way real ones do. */
function fakeStorage(options: { throwOn?: "get" | "set" | "remove" } = {}): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => {
      if (options.throwOn === "get") throw new Error("blocked");
      return map.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (options.throwOn === "set") throw new Error("quota");
      map.set(key, value);
    },
    removeItem: (key: string) => {
      if (options.throwOn === "remove") throw new Error("blocked");
      map.delete(key);
    },
  } as Storage;
}

describe("onboarding draft", () => {
  it("returns an empty draft when nothing has been typed", () => {
    expect(readDraft(fakeStorage())).toEqual(EMPTY_DRAFT);
  });

  it("survives a restart: what was typed comes back", () => {
    const storage = fakeStorage();
    writeDraft({ name: "Ada", email: "ada@example.com" }, storage);
    expect(readDraft(storage)).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("keeps a half-filled form", () => {
    const storage = fakeStorage();
    writeDraft({ name: "Ada", email: "" }, storage);
    expect(readDraft(storage)).toEqual({ name: "Ada", email: "" });
  });

  it("stores nothing for an empty form rather than a blank record", () => {
    const storage = fakeStorage();
    writeDraft({ name: "Ada", email: "a@b.co" }, storage);
    writeDraft({ name: "", email: "" }, storage);
    expect(storage.length).toBe(0);
  });

  it("is forgotten once onboarding is done", () => {
    const storage = fakeStorage();
    writeDraft({ name: "Ada", email: "ada@example.com" }, storage);
    clearDraft(storage);
    expect(readDraft(storage)).toEqual(EMPTY_DRAFT);
  });

  it("ignores a corrupt or hostile stored value instead of rendering it", () => {
    const storage = fakeStorage();
    for (const junk of ["not json", "null", "[1,2,3]", '"a string"', '{"name":{"toString":1}}']) {
      storage.setItem("danibot.onboarding-draft", junk);
      expect(readDraft(storage), junk).toEqual(EMPTY_DRAFT);
    }
  });

  it("keeps only the fields it owns", () => {
    const storage = fakeStorage();
    storage.setItem("danibot.onboarding-draft", JSON.stringify({ name: "Ada", email: "a@b.co", admin: true }));
    expect(readDraft(storage)).toEqual({ name: "Ada", email: "a@b.co" });
  });

  it("bounds a stored value so a huge one cannot be restored into the form", () => {
    const storage = fakeStorage();
    storage.setItem("danibot.onboarding-draft", JSON.stringify({ name: "x".repeat(10_000), email: "" }));
    expect(readDraft(storage).name.length).toBe(320);
  });

  it("never throws when storage is unavailable in either direction", () => {
    expect(() => writeDraft({ name: "Ada", email: "a@b.co" }, fakeStorage({ throwOn: "set" }))).not.toThrow();
    expect(readDraft(fakeStorage({ throwOn: "get" }))).toEqual(EMPTY_DRAFT);
    expect(() => clearDraft(fakeStorage({ throwOn: "remove" }))).not.toThrow();
  });
});
