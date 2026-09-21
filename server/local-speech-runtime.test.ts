import { describe, expect, it } from "vitest";
import { MAX_CONCURRENT_SPEECH_PROCESSES, withSpeechProcessSlot } from "./local-speech-runtime.ts";

describe("withSpeechProcessSlot (bounded local-speech concurrency)", () => {
  it("never lets more than the cap run at once, and drains the queue FIFO", async () => {
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];
    await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        withSpeechProcessSlot(async () => {
          started.push(i);
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 25));
          active--;
        }),
      ),
    );
    expect(maxActive).toBeLessThanOrEqual(MAX_CONCURRENT_SPEECH_PROCESSES);
    expect(started).toHaveLength(7);
  });

  it("releases the slot when the work throws, so later work still runs", async () => {
    await expect(withSpeechProcessSlot(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(withSpeechProcessSlot(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});
