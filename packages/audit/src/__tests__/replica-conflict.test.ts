import type { AuditEvent } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { appendAuditEvent } from "../append.js";
import {
  AUDIT_CHAIN_GENESIS,
  createChainedAuditSink,
  verifyAuditChain,
} from "../chain.js";
import { isAuditPredecessorConflict } from "../conflict.js";

function wrappedConflict(constraint = "audit_events_previous_digest_uidx") {
  return new Error("query rejected", {
    cause: Object.assign(new Error("unique violation"), {
      code: "23505",
      constraint,
    }),
  });
}

it("unwraps only the exact predecessor constraint and bounds cause traversal", () => {
  expect(isAuditPredecessorConflict(wrappedConflict())).toBe(true);
  expect(isAuditPredecessorConflict(wrappedConflict("audit_events_pkey"))).toBe(
    false,
  );
  expect(
    isAuditPredecessorConflict(
      Object.assign(new Error("conflict"), {
        code: "23505",
        constraint_name: "audit_events_previous_digest_uidx",
      }),
    ),
  ).toBe(true);
  const cycle = new Error("cyclic cause");
  cycle.cause = cycle;
  expect(isAuditPredecessorConflict(cycle)).toBe(false);
});

it("relinks contending replica writes without losing, forking, or reordering stored events", async () => {
  const rows: AuditEvent[] = [];
  const tip = () => rows.at(-1)?.digest ?? AUDIT_CHAIN_GENESIS;
  const shared = {
    async append(event: AuditEvent) {
      await Promise.resolve();
      if (event.previousDigest !== tip()) throw wrappedConflict();
      rows.push(event);
      return event;
    },
  };
  const writers = Array.from({ length: 8 }, () =>
    createChainedAuditSink(shared, { tip: async () => tip() }),
  );
  await Promise.all(
    writers.map((writer, index) =>
      appendAuditEvent(writer, {
        id: `replica-${index}`,
        eventType: "replica.append",
        outcome: "succeeded",
      }),
    ),
  );
  expect(rows).toHaveLength(8);
  expect(new Set(rows.map((row) => row.id)).size).toBe(8);
  expect(verifyAuditChain(rows).ok).toBe(true);
});

it("fails closed after bounded predecessor contention without advancing the local tip", async () => {
  let attempts = 0;
  const sink = createChainedAuditSink(
    {
      append: async () => {
        attempts++;
        throw wrappedConflict();
      },
    },
    { tip: async () => AUDIT_CHAIN_GENESIS },
  );
  await expect(
    appendAuditEvent(sink, { eventType: "contention", outcome: "denied" }),
  ).rejects.toThrow("query rejected");
  expect(attempts).toBe(32);
  expect(sink.tip()).toBe(AUDIT_CHAIN_GENESIS);
});
