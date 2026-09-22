import { describe, expect, it } from "vitest";
import { FORBIDDEN, forbiddenIn } from "./check-release-ui.mjs";

describe("release UI bundle check", () => {
  it("passes a bundle that only speaks product language", () => {
    expect(forbiddenIn('const a="Preparing Dani…";const b="Try again";')).toEqual([]);
  });

  it("catches a leaked install command", () => {
    expect(forbiddenIn('x("curl -fsSL https://example.test/install.sh | bash")')).toContain("curl -fsSL");
  });

  it("catches a leaked Terminal action and setup guide", () => {
    const hits = forbiddenIn('"Open install in Terminal" "View setup guide"');
    expect(hits).toContain("Open install in Terminal");
    expect(hits).toContain("View setup guide");
  });

  it("catches the harness chooser copy", () => {
    expect(forbiddenIn('"Your engines"')).toContain("Your engines");
    expect(forbiddenIn('"Choose model"')).toContain("Choose model");
  });

  it("reports every survivor, not just the first", () => {
    expect(forbiddenIn(FORBIDDEN.join(" ")).length).toBe(FORBIDDEN.length);
  });
});
