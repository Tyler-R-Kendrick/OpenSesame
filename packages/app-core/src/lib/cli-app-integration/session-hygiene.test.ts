import { describe, expect, it } from "vitest";
import { CliAppIntegrationStore } from "./session.js";

describe("CliAppIntegrationStore hygiene", () => {
  it("keeps every pending request up to the cap", () => {
    const store = new CliAppIntegrationStore(() => 1_000);
    const first = store.ensure("term-a", "read");
    const second = store.ensure("term-b", "read");
    expect(store.listPending().map((row) => row.requestId)).toEqual([
      first.requestId,
      second.requestId,
    ]);
    expect(store.approve(first.requestId ?? "", "term-a").status).toBe(
      "approved",
    );
    expect(store.listPending().map((row) => row.terminalSessionId)).toEqual([
      "term-b",
    ]);

    const capped = new CliAppIntegrationStore(() => 2_000);
    for (let i = 0; i < 8; i += 1) {
      expect(capped.ensure(`term-${i}`, "read").status).toBe("pending");
    }
    expect(capped.ensure("term-overflow", "read").status).toBe("denied");
    expect(capped.listPending()).toHaveLength(8);
    const oldest = capped.listPending()[0];
    expect(oldest?.terminalSessionId).toBe("term-0");
    expect(
      capped.deny(oldest?.requestId ?? "", oldest?.terminalSessionId ?? "")
        .status,
    ).toBe("denied");
    expect(capped.ensure("term-overflow", "read").status).toBe("pending");
    expect(capped.listPending()).toHaveLength(8);
  });

  it("coalesces same verb and reference", () => {
    const store = new CliAppIntegrationStore();
    const first = store.ensure("term-a", "reveal", "x");
    const second = store.ensure("term-a", "reveal", "x");
    expect(first.requestId).toBe(second.requestId);
  });

  it("rate limits ensure for one terminal session", () => {
    let now = 0;
    const store = new CliAppIntegrationStore(() => now);
    for (let i = 0; i < 8; i += 1) {
      expect(store.ensure("term-a", "reveal").status).toBe("pending");
      now += 1;
    }
    expect(store.ensure("term-a", "reveal").status).toBe("denied");
  });
});
