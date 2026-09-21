import { createHash } from "node:crypto";
import { callTool, type HostRequest } from "../drivers/browser-proxy.ts";
import type { KernelAdapterContext, KernelEffectAdapter, KernelInspection } from "./effect-service.ts";

const READ_ONLY = new Set(["browser_snapshot", "browser_read", "browser_state", "browser_screenshot"]);
const SUPPORTED = new Set([
  "browser_navigate", "browser_click", "browser_fill", "browser_type", "browser_press",
  "browser_scroll", "browser_hover", "browser_drag", "browser_select_option", "browser_wait_for",
  "browser_back", "browser_forward", ...READ_ONLY,
]);
export interface BrowserKernelInput {
  tool: string;
  arguments?: unknown;
  reconcile?: { url?: string; titleIncludes?: string };
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (result: Awaited<ReturnType<typeof callTool>>) => result.content
  .filter((item): item is { type: "text"; text: string } => item.type === "text")
  .map(item => item.text).join("\n");

export class BrowserKernelAdapter implements KernelEffectAdapter {
  readonly name = "browser";
  readonly idempotency = "reconcile" as const;
  constructor(private readonly request: HostRequest) {}

  async execute(raw: unknown, context: KernelAdapterContext) {
    const input = raw as Partial<BrowserKernelInput>;
    if (!input.tool || !SUPPORTED.has(input.tool)) throw new Error("unsupported browser kernel tool");
    const result = await callTool(input.tool, input.arguments ?? {}, this.request);
    if (result.isError) throw new Error(text(result) || "browser effect failed");
    const state = await this.request("state") as { url?: unknown };
    const url = typeof state.url === "string" ? state.url : "about:blank";
    return { externalReference: `browser:${context.idempotencyKey}:${digest({ tool: input.tool, url })}` };
  }

  async inspect(_reference: string, context: KernelAdapterContext): Promise<KernelInspection> {
    const state = await this.request("state") as { url?: unknown; title?: unknown; loading?: unknown };
    const url = typeof state.url === "string" ? state.url : "";
    return {
      confirmed: Boolean(url && url !== "about:blank"), sourceTimestamp: new Date().toISOString(),
      sourceReference: url || `browser:${context.effectId}`,
      inspection: { url, title: typeof state.title === "string" ? state.title : "", loading: state.loading === true },
    };
  }

  async reconcile(raw: unknown, context: KernelAdapterContext) {
    const input = raw as Partial<BrowserKernelInput>;
    const inspection = await this.inspect(`browser:${context.effectId}`, context);
    const observed = inspection.inspection as { url?: string; title?: string };
    const expectation = input.reconcile;
    const confirmed = READ_ONLY.has(String(input.tool))
      ? inspection.confirmed
      : Boolean(
          inspection.confirmed && expectation &&
          (expectation.url === undefined || observed.url === expectation.url) &&
          (expectation.titleIncludes === undefined || observed.title?.includes(expectation.titleIncludes)) &&
          (expectation.url !== undefined || expectation.titleIncludes !== undefined)
        );
    return {
      ...inspection,
      // An arbitrary nonblank page is not proof that a write landed. Writes
      // require an exact adapter-owned postcondition supplied at proposal.
      confirmed,
      externalReference: confirmed ? `browser:${context.idempotencyKey}:${digest(inspection.inspection)}` : undefined,
    };
  }
}
