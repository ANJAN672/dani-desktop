import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPackagedKernelProfileSmoke } from "./packaged-profile-smoke.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe("packaged kernel profile smoke", () => {
  it("executes once and proves restart duplicate suppression", async () => {
    const root = mkdtempSync(join(tmpdir(), "dani-packaged-kernel-")); roots.push(root);
    await expect(runPackagedKernelProfileSmoke(root, "clean-01")).resolves.toMatchObject({
      phase: "executed", externalWrites: 1, evidenceCount: 1, duplicatePrevented: false,
      proactivePhase: "proposed", proactiveProposalCount: 1, proactiveCancelGeneration: 2,
    });
    await expect(runPackagedKernelProfileSmoke(root, "clean-01")).resolves.toMatchObject({
      phase: "recovered", externalWrites: 1, evidenceCount: 1, duplicatePrevented: true,
      proactivePhase: "recovered", proactiveProposalCount: 1, proactiveCancelGeneration: 2,
    });
  });
});
