import { describe, expect, it } from "vitest";
import { CliAppIntegrationStore } from "./session.js";

describe("CliAppIntegrationStore hygiene", () => {
  it("refuses all when more than one pending", () => {
    const store = new CliAppIntegrationStore();
    store.ensure("term-a", "read");
    store.ensure("term-b", "read");
    expect(store.listPending()).toHaveLength(0);
  });

  it("coalesces same verb and reference", () => {
    const store = new CliAppIntegrationStore();
    const first = store.ensure("term-a", "read", "x");
    const second = store.ensure("term-a", "read", "x");
    expect(first.requestId).toBe(second.requestId);
  });

  it("rate limits ensure for one terminal session", () => {
    let now = 0;
    const store = new CliAppIntegrationStore(() => now);
    for (let i = 0; i < 8; i += 1) {
      expect(store.ensure("term-a", "read").status).toBe("pending");
      now += 1;
    }
    expect(store.ensure("term-a", "read").status).toBe("denied");
  });
});
