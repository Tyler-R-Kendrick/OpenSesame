import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AuditEvent, overlapCast } from "@opensesame/os-domain";
import { assertNoSecretFields, assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { appendAuditEvent } from "../append.js";
import {
  AUDIT_CHAIN_GENESIS,
  createChainedAuditSink,
  verifyAuditChain,
} from "../chain.js";

const here = dirname(fileURLToPath(import.meta.url));

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

describe("PACT — identity audit chain", () => {
  it("compares digests with timingSafeEqual after hashing canonical fields", () => {
    assertSourceOrder(readFileSync(join(here, "../chain.ts"), "utf8"), [
      "canonicalAuditPayload",
      'createHash("sha256")',
      "timingSafeEqual",
      "queue.then",
    ]);
  });

  it("property: many serialized appends still verify as one chain", async () => {
    const store = memorySink();
    const sink = createChainedAuditSink(store);
    const n = 24;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        appendAuditEvent(sink, {
          eventType: `a.${i}`,
          outcome: i % 2 === 0 ? "succeeded" : "denied",
        }),
      ),
    );
    expect(store.rows).toHaveLength(n);
    expect(verifyAuditChain(store.rows).ok).toBe(true);
    expect(store.rows[0]?.previousDigest).toBe(AUDIT_CHAIN_GENESIS);
  });

  it("chaos: a failed append does not poison the next digest link", async () => {
    const store = memorySink();
    let failNext = true;
    const flaky = {
      append: async (event: AuditEvent) => {
        if (failNext) {
          failNext = false;
          throw new Error("partition");
        }
        return store.append(event);
      },
    };
    const sink = createChainedAuditSink(flaky);
    await expect(
      appendAuditEvent(sink, { eventType: "a.lost", outcome: "succeeded" }),
    ).rejects.toThrow(/partition/);
    await appendAuditEvent(sink, { eventType: "a.kept", outcome: "succeeded" });
    expect(verifyAuditChain(store.rows).ok).toBe(true);
    expect(store.rows[0]?.eventType).toBe("a.kept");
    expect(store.rows[0]?.previousDigest).toBe(AUDIT_CHAIN_GENESIS);
  });

  it("contract: verified events do not carry secret fields", async () => {
    const store = memorySink();
    const sink = createChainedAuditSink(store);
    await appendAuditEvent(sink, {
      eventType: "claim.completed",
      outcome: "succeeded",
    });
    assertNoSecretFields(overlapCast(store.rows[0]));
  });
});
