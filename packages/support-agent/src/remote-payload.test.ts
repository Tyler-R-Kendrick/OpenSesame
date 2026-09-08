import { describe, expect, it } from "vitest";
import { fakeSupportPageContext } from "./fake.js";
import {
  redactSupportQuestion,
  remoteSupportPayload,
} from "./remote-payload.js";

describe("remote support data boundary", () => {
  it("drops history, labels, live state, tool status and seeded sentinel fields", () => {
    const context = fakeSupportPageContext();
    const sent = JSON.stringify(
      remoteSupportPayload({
        question: "How do I lock?",
        history: [{ role: "user", text: "HISTORY_SENTINEL" }],
        context: {
          ...context,
          targets: [
            {
              id: "nav.vault",
              role: "navigation",
              mounted: true,
              description: "VAULT_SENTINEL",
            },
          ],
          state: [{ id: "vault.unlocked", value: true }],
          tools: [
            {
              name: "HOST_SENTINEL",
              description: "LOCAL_ENDPOINT_SENTINEL",
              exposed: true,
            },
          ],
        },
      }),
    );
    for (const secret of [
      "HISTORY_SENTINEL",
      "VAULT_SENTINEL",
      "HOST_SENTINEL",
      "LOCAL_ENDPOINT_SENTINEL",
      "vault.unlocked",
    ])
      expect(sent).not.toContain(secret);
  });
  it.each([
    "password=correct-horse",
    "https://private.example/account",
    "human@example.com",
    "123456",
    "abcdefghijklmnopqrstuvwxyz123456789",
  ])("redacts %s before preview", (text) => {
    expect(redactSupportQuestion(text)).not.toContain(text);
  });
  it("refuses oversized questions and hostile identifiers", () => {
    expect(() => redactSupportQuestion("a".repeat(2001))).toThrow();
    expect(() =>
      remoteSupportPayload({
        question: "help",
        history: [],
        context: {
          ...fakeSupportPageContext(),
          route: "https://attacker.example",
        },
      }),
    ).toThrow();
  });
});
