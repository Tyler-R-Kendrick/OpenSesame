import type { AuditEvent } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { appendAuditEvent } from "../append.js";
import {
  AUDIT_CHAIN_GENESIS,
  auditEventDigest,
  createChainedAuditSink,
  verifyAuditChain,
} from "../chain.js";

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

describe("audit chain", () => {
  it("links each event to the one before it", async () => {
    const store = memorySink();
    const sink = createChainedAuditSink(store);
    for (const eventType of ["a.one", "a.two", "a.three"]) {
      await appendAuditEvent(sink, { eventType, outcome: "succeeded" });
    }
    expect(store.rows[0]?.previousDigest).toBe(AUDIT_CHAIN_GENESIS);
    expect(store.rows[1]?.previousDigest).toBe(store.rows[0]?.digest);
    expect(store.rows[2]?.previousDigest).toBe(store.rows[1]?.digest);
    const verdict = verifyAuditChain(store.rows);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.tip).toBe(sink.tip());
  });

  it("notices an event edited in place", async () => {
    const store = memorySink();
    const sink = createChainedAuditSink(store);
    await appendAuditEvent(sink, { eventType: "a.one", outcome: "denied" });
    await appendAuditEvent(sink, { eventType: "a.two", outcome: "succeeded" });
    // The shape a cover-up takes: a refusal rewritten as a success.
    store.rows[0]!.outcome = "succeeded";
    const verdict = verifyAuditChain(store.rows);
    expect(verdict).toMatchObject({
      ok: false,
      reason: "altered",
      eventId: store.rows[0]!.id,
    });
  });

  it("notices an event removed from the middle", async () => {
    const store = memorySink();
    const sink = createChainedAuditSink(store);
    await appendAuditEvent(sink, { eventType: "a.one", outcome: "succeeded" });
    await appendAuditEvent(sink, { eventType: "a.two", outcome: "denied" });
    await appendAuditEvent(sink, {
      eventType: "a.three",
      outcome: "succeeded",
    });
    const withoutMiddle = [store.rows[0]!, store.rows[2]!];
    expect(verifyAuditChain(withoutMiddle)).toMatchObject({
      ok: false,
      reason: "broken",
      eventId: store.rows[2]!.id,
    });
  });

  it("notices a trail that was never linked at all", () => {
    const bare: AuditEvent = {
      id: "e1",
      occurredAt: new Date("2026-08-08T00:00:00.000Z"),
      eventType: "a.one",
      outcome: "succeeded",
      correlationId: "c1",
      metadata: {},
    };
    expect(verifyAuditChain([bare])).toMatchObject({
      ok: false,
      reason: "unlinked",
    });
  });

  it("does not let key order change a digest", () => {
    const base: AuditEvent = {
      id: "e1",
      occurredAt: new Date("2026-08-08T00:00:00.000Z"),
      eventType: "a.one",
      outcome: "succeeded",
      correlationId: "c1",
      metadata: { reason: "x", action: "y" },
    };
    const reordered: AuditEvent = {
      ...base,
      metadata: { action: "y", reason: "x" },
    };
    expect(auditEventDigest(base, "t")).toBe(auditEventDigest(reordered, "t"));
    // Content, on the other hand, must move it.
    expect(auditEventDigest(base, "t")).not.toBe(
      auditEventDigest({ ...base, metadata: { reason: "z" } }, "t"),
    );
    expect(auditEventDigest(base, "t")).not.toBe(auditEventDigest(base, "u"));
  });

  it("keeps concurrent appends in one line", async () => {
    const store = memorySink();
    const sink = createChainedAuditSink(store);
    await Promise.all(
      ["a.one", "a.two", "a.three", "a.four"].map((eventType) =>
        appendAuditEvent(sink, { eventType, outcome: "succeeded" }),
      ),
    );
    // Two events sharing a predecessor would leave one of them unverifiable.
    expect(verifyAuditChain(store.rows).ok).toBe(true);
  });

  it("resumes a trail from its tip", async () => {
    const first = memorySink();
    const one = createChainedAuditSink(first);
    await appendAuditEvent(one, { eventType: "a.one", outcome: "succeeded" });
    const second = createChainedAuditSink(first, { tip: one.tip() });
    await appendAuditEvent(second, {
      eventType: "a.two",
      outcome: "succeeded",
    });
    expect(verifyAuditChain(first.rows).ok).toBe(true);
  });

  it("does not advance the tip past an append that failed", async () => {
    const store = memorySink();
    let failNext = true;
    const flaky = {
      append: async (event: AuditEvent) => {
        if (failNext) {
          failNext = false;
          throw new Error("store unavailable");
        }
        return store.append(event);
      },
    };
    const sink = createChainedAuditSink(flaky);
    await expect(
      appendAuditEvent(sink, { eventType: "a.lost", outcome: "succeeded" }),
    ).rejects.toThrow(/unavailable/);
    await appendAuditEvent(sink, { eventType: "a.kept", outcome: "succeeded" });
    // The event that never landed left no gap for the next one to point at.
    expect(verifyAuditChain(store.rows).ok).toBe(true);
    expect(store.rows[0]?.previousDigest).toBe(AUDIT_CHAIN_GENESIS);
  });
});
