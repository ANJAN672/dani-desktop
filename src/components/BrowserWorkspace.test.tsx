import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("./BrowserPanel", () => ({
  BrowserPanel: ({ bot }: { bot: Bot }) => <div data-browser-panel={bot.id}>Shared browser</div>,
}));

import { BrowserWorkspace } from "./BrowserWorkspace";

describe("BrowserWorkspace", () => {
  it("renders the existing browser panel for the selected bot without a second control interface", () => {
    const bot = { id: "browser-bot-1", name: "DANI" } as Bot;
    const markup = renderToStaticMarkup(<BrowserWorkspace bot={bot} onClose={() => {}} />);

    expect(markup).toContain("DANI&#x27;s browser");
    expect(markup).toContain('data-browser-panel="browser-bot-1"');
    expect(markup).toContain('aria-label="Back to the small browser"');
    expect(markup).not.toContain("computer/control");
  });
});
