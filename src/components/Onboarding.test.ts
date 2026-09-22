import { vi } from "vitest";

// Module init reads window.dani for platform capabilities; tests run in node.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RuntimePreparation } from "./RuntimePreparation";

/** Everything the release first run must never say (spec 110 R-UI-001,
 * acceptance criterion 2) — harness vocabulary, install commands, and the
 * Terminal/setup-guide escape hatches. */
const FORBIDDEN = [
  "hermes",
  "engine",
  "harness",
  "curl",
  "powershell",
  "iex",
  "terminal",
  "setup guide",
  "not installed",
  "choose model",
  "cli",
];

function firstRunMarkup(): string {
  return renderToStaticMarkup(
    createElement(RuntimePreparation, { onReady: () => {}, onContinueLimited: () => {} }),
  );
}

describe("first-run runtime preparation", () => {
  it("speaks product language while preparing", () => {
    expect(firstRunMarkup()).toContain("Preparing");
  });

  it("exposes no harness choice, install command or terminal escape", () => {
    const markup = firstRunMarkup().toLowerCase();
    for (const phrase of FORBIDDEN) expect(markup).not.toContain(phrase);
  });

  it("does not report readiness before the live probe answers", () => {
    let ready = 0;
    renderToStaticMarkup(
      createElement(RuntimePreparation, { onReady: () => { ready += 1; }, onContinueLimited: () => {} }),
    );
    expect(ready).toBe(0);
    // Continue stays disabled until the server answers, so no one can click
    // past preparation into a runtime that was never verified.
    expect(firstRunMarkup()).toContain("disabled");
  });
});
