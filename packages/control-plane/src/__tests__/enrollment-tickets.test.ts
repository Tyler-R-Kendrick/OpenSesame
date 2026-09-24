import { describe, expect, it } from "vitest";
import {
  ENROLLMENT_TICKET_TTL_MS_MAX,
  ENROLLMENT_TICKET_TTL_MS_MIN,
  clampEnrollmentTtlMs,
  consumeEnrollmentTicket,
  hashEnrollmentTicket,
  storeEnrollmentTicket,
} from "../repos/enrollment-tickets.js";

describe("enrollment tickets", () => {
  it("clamps ttl and hashes the presented secret", () => {
    expect(clampEnrollmentTtlMs(500)).toBe(ENROLLMENT_TICKET_TTL_MS_MIN);
    expect(clampEnrollmentTtlMs(99_999_999)).toBe(ENROLLMENT_TICKET_TTL_MS_MAX);
    expect(hashEnrollmentTicket("abc")).toHaveLength(64);
    expect(hashEnrollmentTicket("abc")).not.toBe("abc");
  });

  it("consumes a memory ticket once and refuses expiry", async () => {
    const store = new Map();
    const now = new Date("2026-09-17T00:00:00.000Z");
    const minted = await storeEnrollmentTicket(store, now, 60_000);
    expect(store.size).toBe(1);
    const first = await consumeEnrollmentTicket(store, minted.ticket, now);
    expect(first?.id).toBe(minted.id);
    expect(
      await consumeEnrollmentTicket(store, minted.ticket, now),
    ).toBeUndefined();
    const expired = await storeEnrollmentTicket(store, now, 60_000);
    expect(
      await consumeEnrollmentTicket(
        store,
        expired.ticket,
        new Date(now.getTime() + 61_000),
      ),
    ).toBeUndefined();
  });
});
