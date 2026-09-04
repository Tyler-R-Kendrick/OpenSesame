import { describe, expect, it } from "vitest";
import type { ConnectorStatus } from "./connectors.js";
import { needsAttention } from "./connectors.js";

/**
 * What the connectivity chip counts, and what it deliberately does not.
 *
 * Its own file because the rule changed with ADR 0090: every plane became
 * optional, which left the connectors' `required` flag with no true case, and
 * the count with exactly one thing to mean — an endpoint somebody configured
 * that is not answering.
 */

const base = {
  failure: null,
  lastCheckedAt: null,
  checking: false,
  rttMs: null,
} as const;

describe("needsAttention", () => {
  it("never counts an endpoint nobody configured", () => {
    // Every plane is optional (ADR 0090), so an address nobody typed is not a
    // fault. `off` is the tone for "not configured"; only `attn` is a fault.
    const list: ConnectorStatus[] = [
      { id: "host", name: "Host", tone: "off", detail: "", ...base },
      {
        id: "identity",
        name: "Identity",
        tone: "off",
        detail: "",
        ...base,
      },
      {
        id: "machine",
        name: "This machine",
        tone: "off",
        detail: "",
        ...base,
      },
    ];
    expect(needsAttention(list)).toBe(0);
  });

  it("leaves a binding's own attention to the binding", () => {
    // Git history waiting to be authorized is a thing to finish, not an
    // address that stopped answering, so it never lands in this count.
    const list: ConnectorStatus[] = [
      { id: "history", name: "Git history", tone: "attn", detail: "", ...base },
      { id: "keys", name: "Key vault", tone: "attn", detail: "", ...base },
    ];
    expect(needsAttention(list)).toBe(0);
  });
});
