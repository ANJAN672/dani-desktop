import { describe, expect, it, vi } from "vitest";

import {
  transcriptionStatus,
  transcriptionStreamingToken,
  withTranscriptionKey,
} from "./transcription-bridge.mjs";

describe("AssemblyAI transcription bridge", () => {
  it("reports the encrypted credential before the environment fallback", () => {
    expect(transcriptionStatus(
      { assemblyAiApiKey: "stored" },
      { ASSEMBLYAI_API_KEY: "environment" },
    )).toEqual({ configured: true });
    expect(transcriptionStatus({}, { ASSEMBLYAI_API_KEY: "environment" }))
      .toEqual({ configured: true });
    expect(transcriptionStatus({}, {})).toEqual({ configured: false });
  });

  it("sets and clears only the transcription credential", () => {
    const base = { unrelated: "kept", assemblyAiApiKey: "old" };
    expect(withTranscriptionKey(base, " new ")).toEqual({
      unrelated: "kept",
      assemblyAiApiKey: "new",
    });
    expect(withTranscriptionKey(base, " ")).toEqual({ unrelated: "kept" });
    expect(base).toEqual({ unrelated: "kept", assemblyAiApiKey: "old" });
  });

  it("mints a token from the permanent key without exposing it to the renderer", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: "temporary" }),
    }));
    await expect(transcriptionStreamingToken(
      { assemblyAiApiKey: "permanent" },
      {},
      { fetchImpl, expiresInSeconds: 120 },
    )).resolves.toEqual({ token: "temporary", expiresInSeconds: 120 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://streaming.assemblyai.com/v3/token?expires_in_seconds=120",
      {
        headers: { authorization: "permanent" },
        signal: expect.any(AbortSignal),
      },
    );
  });
});
