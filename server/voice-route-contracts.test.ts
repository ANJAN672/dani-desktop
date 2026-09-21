import { describe, expect, it } from "vitest";

import { prepareSpeechInputSchema, speakSpeechInputSchema, voiceInputError } from "./voice-route-contracts.ts";

describe("voice route contracts", () => {
  it("rejects coercion and unknown fields", () => {
    expect(() => speakSpeechInputSchema.parse({ text: 123 })).toThrow();
    expect(() => speakSpeechInputSchema.parse({ text: "hello", provider: "other" })).toThrow();
    expect(() => speakSpeechInputSchema.parse({ text: "hello", voiceId: "" })).toThrow();
  });

  it("normalizes bounded speech input", () => {
    expect(speakSpeechInputSchema.parse({ text: "  hello  ", voiceId: " voice " })).toEqual({ text: "hello", voiceId: "voice" });
    const oversized = speakSpeechInputSchema.safeParse({ text: "x".repeat(501) });
    expect(oversized.success).toBe(false);
    if (!oversized.success) expect(voiceInputError(oversized.error)).toEqual({ status: 413, message: "voice utterances are limited to 500 characters" });
    expect(() => speakSpeechInputSchema.parse({ text: "   " })).toThrow();
    expect(speakSpeechInputSchema.parse({ text: ` ${"é".repeat(500)} ` }).text).toHaveLength(500);
  });

  it("bounds preparation without changing valid text", () => {
    expect(prepareSpeechInputSchema.parse({ text: "hello" })).toEqual({ text: "hello" });
    expect(() => prepareSpeechInputSchema.parse({ text: "x".repeat(100_001) })).toThrow();
  });
});
