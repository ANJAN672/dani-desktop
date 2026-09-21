import { describe, expect, it } from "vitest";
import { decideInitiative, localToUtc, nextQuietEnd, validateQuietHours, withinQuietHours, type InitiativeInput } from "./dani-policy.ts";

const base: InitiativeInput = { consent: true, novelty: 1, confidence: 1, urgency: 0.5, risk: "write", notificationsInWindow: 0, notificationBudget: 5, relevantToCurrentTask: true, quietHoursActive: false };

describe("initiative levels", () => {
  it.each([
    ["no consent stays silent", { consent: false }, "silent", ["no-consent"]],
    ["rate budget stays silent", { notificationsInWindow: 5 }, "silent", ["rate-budget"]],
    ["low novelty stays silent", { novelty: 0.1 }, "silent", ["low-novelty"]],
    ["quiet hours defer", { quietHoursActive: true }, "silent", ["quiet-hours"]],
    ["irrelevant low-urgency stays silent", { relevantToCurrentTask: false, urgency: 0.5 }, "silent", ["not-relevant"]],
    ["urgent confident relevant write acts", { urgency: 0.9 }, "act", ["urgent-and-confident"]],
    ["money risk caps at inform", { urgency: 0.9, risk: "money" }, "inform", ["high-risk-capped-at-inform"]],
    ["destructive risk caps at inform", { urgency: 0.9, risk: "destructive" }, "inform", ["high-risk-capped-at-inform"]],
    ["preparable mid-urgency prepares", { preparable: true, confidence: 0.6 }, "prepare", ["preparable"]],
    ["moderate signal informs", { confidence: 0.6 }, "inform", ["worth-informing"]],
    ["weak signal stays silent", { confidence: 0.1, urgency: 0.1 }, "silent", ["below-threshold"]],
  ] as const)("%s", (_name, patch, level, reasons) => {
    const decision = decideInitiative({ ...base, ...patch });
    expect(decision.level).toBe(level);
    expect(reasons).toEqual(expect.arrayContaining(decision.reasons.filter(r => (reasons as readonly string[]).includes(r))));
    expect(decision.reasons).toEqual(expect.arrayContaining(reasons as unknown as string[]));
    expect(decision.deferred).toBe(level === "silent" && (patch as InitiativeInput).quietHoursActive === true && !((patch as InitiativeInput).urgentOverride));
  });

  it("act always requires broker approval; other levels never claim it", () => {
    expect(decideInitiative({ ...base, urgency: 0.9 }).requiresBrokerApproval).toBe(true);
    expect(decideInitiative({ ...base, urgency: 0.9, risk: "money" }).requiresBrokerApproval).toBe(false);
    expect(decideInitiative({ ...base }).requiresBrokerApproval).toBe(false);
  });

  it("urgent override during quiet hours is explicit and not deferred", () => {
    const decision = decideInitiative({ ...base, urgency: 0.9, quietHoursActive: true, urgentOverride: true });
    expect(decision.level).toBe("act");
    expect(decision.deferred).toBe(false);
    expect(decision.reasons).toContain("urgent-override");
  });
});

describe("quiet hours validation and release timing", () => {
  const quiet = { timezone: "Asia/Calcutta", start: "22:00", end: "07:00" };
  it("rejects invalid timezone, invalid times and empty windows (fail closed)", () => {
    expect(validateQuietHours({ timezone: "Not/AZone", start: "22:00", end: "07:00" })).toEqual({ ok: false, reason: "invalid-timezone" });
    expect(validateQuietHours({ timezone: "UTC", start: "25:00", end: "07:00" })).toEqual({ ok: false, reason: "invalid-time" });
    expect(validateQuietHours({ timezone: "UTC", start: "07:00", end: "07:00" })).toEqual({ ok: false, reason: "empty-window" });
    expect(validateQuietHours(quiet)).toEqual({ ok: true });
  });
  it("computes the next quiet end for overnight windows", () => {
    const at = new Date("2026-09-20T17:00:00Z"); // 22:30 IST
    expect(withinQuietHours(at, quiet)).toBe(true);
    expect(nextQuietEnd(at, quiet).toISOString()).toBe("2026-09-21T01:30:00.000Z"); // 07:00 IST next day
    const daytime = new Date("2026-09-20T12:00:00Z"); // 17:30 IST
    expect(nextQuietEnd(daytime, quiet).toISOString()).toBe(daytime.toISOString());
  });
  it("stays correct across the America/New_York spring-forward DST boundary", () => {
    const ny = { timezone: "America/New_York", start: "22:00", end: "07:00" };
    const before = new Date("2026-03-08T03:30:00Z"); // Sat 22:30 EST
    expect(withinQuietHours(before, ny)).toBe(true);
    expect(nextQuietEnd(before, ny).toISOString()).toBe("2026-03-08T11:00:00.000Z"); // 07:00 EDT after the 02:00->03:00 jump
    expect(withinQuietHours(new Date("2026-03-08T10:30:00Z"), ny)).toBe(true); // 06:30 EDT
    expect(withinQuietHours(new Date("2026-03-08T11:30:00Z"), ny)).toBe(false); // 07:30 EDT
  });
  it("stays correct across the fall-back boundary", () => {
    const ny = { timezone: "America/New_York", start: "22:00", end: "07:00" };
    const at = new Date("2026-11-01T07:30:00Z"); // 02:30 EST (after fall-back)
    expect(withinQuietHours(at, ny)).toBe(true);
    expect(nextQuietEnd(at, ny).toISOString()).toBe("2026-11-01T12:00:00.000Z"); // 07:00 EST
  });
  it("converts zoned wall-clock to UTC", () => {
    expect(localToUtc("Asia/Calcutta", 2026, 9, 21, 7, 0).toISOString()).toBe("2026-09-21T01:30:00.000Z");
  });
});
