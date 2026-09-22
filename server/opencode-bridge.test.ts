import { describe, expect, it } from "vitest";
import { buildOpenCodePrompt, OPENCODE_MODEL_ONLY_TOOLS } from "../scripts/opencode-bridge/request-shaping.mjs";

describe("managed OpenCode request shaping", () => {
  it("uses OpenCode only as the exact model route and disables its native tools", () => {
    const request = buildOpenCodePrompt({
      providerID: "opencode",
      modelID: "big-pickle",
      system: "system",
      transcript: "USER: hello",
    });
    expect(request).toEqual({
      model: { providerID: "opencode", modelID: "big-pickle" },
      system: "system",
      tools: OPENCODE_MODEL_ONLY_TOOLS,
      parts: [{ type: "text", text: "USER: hello" }],
    });
    expect(Object.values(request.tools)).not.toContain(true);
    expect(Object.keys(request.tools)).toEqual(expect.arrayContaining(["read", "bash", "question", "task"]));
  });

  it("omits an empty system prompt without changing the user transcript", () => {
    const request = buildOpenCodePrompt({
      providerID: "opencode",
      modelID: "big-pickle",
      system: "",
      transcript: "USER: exact text",
    });
    expect(request).not.toHaveProperty("system");
    expect(request.parts).toEqual([{ type: "text", text: "USER: exact text" }]);
  });
});
