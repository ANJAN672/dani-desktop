import { describe, expect, it } from "vitest";
import { shouldBargeIn, stateAfterPlayback } from "./voice-duplex-policy";

describe("voice duplex policy", () => {
  it("interrupts speech over active Hermes work or playback", () => {
    expect(shouldBargeIn({ state: "listening", botBusy: true, approvalOpen: false })).toBe(true);
    expect(shouldBargeIn({ state: "speaking", botBusy: false, approvalOpen: false })).toBe(true);
  });
  it("never cancels the turn before a spoken approval is parsed", () => {
    expect(shouldBargeIn({ state: "thinking", botBusy: true, approvalOpen: true })).toBe(false);
    expect(shouldBargeIn({ state: "speaking", botBusy: true, approvalOpen: true })).toBe(false);
  });
  it("returns to thinking after commentary while Hermes remains busy", () => {
    expect(stateAfterPlayback(true)).toBe("thinking");
    expect(stateAfterPlayback(false)).toBe("listening");
  });
});
