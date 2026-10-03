import type { AuditEvent } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { appendAuditEvent } from "../append.js";
import { AUDIT_CHAIN_GENESIS, createChainedAuditSink } from "../chain.js";

/** What a sealed store raises for a newest row that will not open (ADR 0155). */
class Unreadable extends Error {
  readonly code = "event_unreadable";
}

function memorySink() {
  const rows: AuditEvent[] = [];
  return {
    rows,
    append: async (event: AuditEvent) => {
      rows.push(event);
      return event;
    },
  };
}

describe("a chain whose newest row will not open", () => {
  it("refuses to append rather than restart at genesis", async () => {
    const store = memorySink();
    const sink = createChainedAuditSink(store, {
      tip: async () => {
        throw new Unreadable("a sealed audit payload could not be opened");
      },
    });
    await expect(
      appendAuditEvent(sink, { eventType: "a.one", outcome: "succeeded" }),
    ).rejects.toBeInstanceOf(Unreadable);
    expect(store.rows).toHaveLength(0);
  });

  it("reads the tip again on the next append, never assuming genesis", async () => {
    const store = memorySink();
    let reads = 0;
    const sink = createChainedAuditSink(store, {
      tip: async () => {
        reads += 1;
        if (reads === 1) throw new Unreadable("unreadable");
        return "recovered-tip";
      },
    });
    await expect(
      appendAuditEvent(sink, { eventType: "a.one", outcome: "succeeded" }),
    ).rejects.toBeInstanceOf(Unreadable);
    await appendAuditEvent(sink, { eventType: "a.two", outcome: "succeeded" });
    expect(store.rows[0]?.previousDigest).toBe("recovered-tip");
    expect(store.rows[0]?.previousDigest).not.toBe(AUDIT_CHAIN_GENESIS);
  });

  it("still tolerates an ordinary read failure", async () => {
    const store = memorySink();
    const sink = createChainedAuditSink(store, {
      tip: async () => {
        throw new Error("store unavailable");
      },
    });
    await appendAuditEvent(sink, { eventType: "a.one", outcome: "succeeded" });
    expect(store.rows[0]?.previousDigest).toBe(AUDIT_CHAIN_GENESIS);
  });
});
