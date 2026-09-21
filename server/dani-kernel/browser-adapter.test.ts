import { describe, expect, it, vi } from "vitest";
import { BrowserKernelAdapter } from "./browser-adapter.ts";
const context = { jobId: "job", effectId: "effect", generation: 1, idempotencyKey: "stable" };
describe("BrowserKernelAdapter", () => {
  it("executes through the existing browser proxy and inspects fresh state", async () => {
    const request = vi.fn(async (operation: string) => operation === "click"
      ? { url: "https://example.test/receipt", title: "Done", elements: [] }
      : { url: "https://example.test/receipt", title: "Done", loading: false });
    const adapter = new BrowserKernelAdapter(request);
    const result = await adapter.execute({ tool: "browser_click", arguments: { ref: "b1" } }, context);
    expect(result.externalReference).toContain("browser:stable:");
    await expect(adapter.inspect(result.externalReference, context)).resolves.toMatchObject({ confirmed: true, sourceReference: "https://example.test/receipt" });
  });
  it("reconciles with a read and never repeats an uncertain write", async () => {
    const request = vi.fn(async () => ({ url: "https://example.test/receipt", title: "Done", loading: false }));
    const adapter = new BrowserKernelAdapter(request);
    await expect(adapter.reconcile({ tool: "browser_click", arguments: { ref: "b1" }, reconcile: { url: "https://example.test/receipt", titleIncludes: "Done" } }, context)).resolves.toMatchObject({ confirmed: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("state");
  });
  it("does not mistake an arbitrary nonblank page for proof that a write landed", async () => {
    const request = vi.fn(async () => ({ url: "https://example.test/form", title: "Form", loading: false }));
    const adapter = new BrowserKernelAdapter(request);
    await expect(adapter.reconcile({ tool: "browser_click", arguments: { ref: "b1" } }, context)).resolves.toMatchObject({ confirmed: false });
  });
  it("fails closed when browser state cannot prove an external result", async () => {
    const adapter = new BrowserKernelAdapter(async () => ({ url: "about:blank", title: "" }));
    await expect(adapter.reconcile({ tool: "browser_click" }, context)).resolves.toMatchObject({ confirmed: false, externalReference: undefined });
  });
});
