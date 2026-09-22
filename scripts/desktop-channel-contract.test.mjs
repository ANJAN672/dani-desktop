import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The desktop shell (electron/) and the embedded server (server/) speak over
// Electron's private utility-process port with message types prefixed by the
// product name. The rebrand renamed the two sides on different schedules and
// the channel silently died: senders emitted danibot:* while receivers only
// accepted openmausbot:* (or the reverse), so packaged builds rejected every
// owner mutation with 403. Each side's own tests passed because each test
// harness modeled its peer with its own prefix.
//
// This contract pins the wire itself: every message-type literal a sender
// file can emit must appear in its receiver's source. Type literals are
// extracted from the real sources, never re-typed here.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const TYPE_LITERAL = /["'`](danibot|openmausbot):[a-z0-9-]+["'`]/g;

function typeLiterals(path, families) {
  const source = read(path);
  const found = new Set();
  for (const match of source.matchAll(TYPE_LITERAL)) {
    const literal = match[0].slice(1, -1);
    if (families.some((family) => literal === `danibot:${family}` || literal === `openmausbot:${family}`)) {
      found.add(literal);
    }
  }
  return found;
}

// sender → receiver, scoped to the message families that pair carries.
const CHANNEL = [
  { sender: "electron/main.mjs", receiver: "server/index.ts", families: ["desktop-mutation-token"] },
  { sender: "electron/main.mjs", receiver: "server/composio.ts", families: ["managed-composio"] },
  { sender: "electron/phone-secret-identity.mjs", receiver: "server/phone-secret.ts", families: ["phone-secret-key", "phone-secret-save-result"] },
  { sender: "electron/browser-control-sync.cjs", receiver: "server/browser-lifecycle-cleanup.ts", families: ["browser-lifecycle-result"] },
  { sender: "electron/browser-connection-sync.cjs", receiver: "server/browser-connection.ts", families: ["browser-connection"] },
  { sender: "server/index.ts", receiver: "electron/browser-control-sync.cjs", families: ["browser-control"] },
  { sender: "server/phone-secret.ts", receiver: "electron/phone-secret-identity.mjs", families: ["phone-secret-save"] },
  { sender: "server/browser-lifecycle-cleanup.ts", receiver: "electron/browser-control-sync.cjs", families: ["browser-bot-deleted", "browser-profile-deleted"] },
];

describe("desktop private channel contract", () => {
  for (const { sender, receiver, families } of CHANNEL) {
    it(`${sender} -> ${receiver}: every emitted ${families.join("/")} type is accepted`, () => {
      const sent = typeLiterals(sender, families);
      expect(
        sent.size,
        `${sender} should emit at least one ${families.join("/")} message type`,
      ).toBeGreaterThan(0);
      const accepted = typeLiterals(receiver, families);
      for (const literal of sent) {
        expect(
          accepted.has(literal),
          `${receiver} does not accept "${literal}" emitted by ${sender}`,
        ).toBe(true);
      }
    });
  }
});
