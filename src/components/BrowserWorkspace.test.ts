import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("./BrowserPanel", () => ({
  BrowserPanel: ({ bot }: { bot: Bot }) => createElement("div", { "data-browser-panel": bot.id }, "Shared browser"),
}));

import { BrowserWorkspace } from "./BrowserWorkspace";

describe("BrowserWorkspace", () => {
  it("renders the shared browser panel for the selected bot and preserves expanded navigation", () => {
    const bot = { id: "browser-bot-1", name: "DANI" } as Bot;
    const markup = renderToStaticMarkup(createElement(BrowserWorkspace, { bot, onClose: () => {} }));

    expect(markup).toContain("DANI&#x27;s browser");
    expect(markup).toContain('data-browser-panel="browser-bot-1"');
    expect(markup).toContain("Shared browser");
    expect(markup).toContain('aria-label="Back to the small browser"');
  });
});
