import { describe, expect, it } from "vitest";
import { spokenApprovalDecision } from "./spoken-approval";

describe("spokenApprovalDecision", () => {
  it("accepts conservative whole-utterance yes/no", () => {
    expect(spokenApprovalDecision("Yes.")).toBe("allow");
    expect(spokenApprovalDecision("do not")).toBe("deny");
  });
  it("never grants from a phrase that merely begins with yes", () => {
    expect(spokenApprovalDecision("yes, but use my other account")).toBeNull();
    expect(spokenApprovalDecision("sure if it costs less")).toBeNull();
    expect(spokenApprovalDecision("I said no yesterday")).toBeNull();
  });
});
