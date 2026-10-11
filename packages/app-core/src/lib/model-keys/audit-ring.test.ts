import { afterEach, describe, expect, it } from "vitest";
import {
  AUDIT_RING_CAPACITY,
  clearModelKeyAuditEvents,
  modelKeyAuditEvents,
  recordModelKeyEvent,
} from "./audit-ring.js";
import type { ModelKeyEvent } from "./types.js";

afterEach(clearModelKeyAuditEvents);

const event = (
  at: number,
  extra: Partial<ModelKeyEvent> = {},
): ModelKeyEvent => ({
  type: "key.revoked",
  at,
  ...extra,
});

describe("the page's audit ring", () => {
  it("keeps what happened, oldest first", () => {
    recordModelKeyEvent(event(1, { keyId: "mk_a" }));
    recordModelKeyEvent(event(2, { type: "root.issued", keyId: "mk_b" }));
    expect(modelKeyAuditEvents().map((e) => [e.type, e.at])).toEqual([
      ["key.revoked", 1],
      ["root.issued", 2],
    ]);
  });

  it("holds at most its capacity, dropping the oldest", () => {
    expect(AUDIT_RING_CAPACITY).toBe(200);
    for (let at = 0; at < AUDIT_RING_CAPACITY + 50; at += 1)
      recordModelKeyEvent(event(at));
    const kept = modelKeyAuditEvents();
    expect(kept).toHaveLength(AUDIT_RING_CAPACITY);
    expect(kept[0]?.at).toBe(50);
    expect(kept.at(-1)?.at).toBe(AUDIT_RING_CAPACITY + 49);
  });

  it("hands out copies, so a reader cannot rewrite the trail", () => {
    const original = event(1, { keyId: "mk_a" });
    recordModelKeyEvent(original);
    const [read] = modelKeyAuditEvents();
    expect(read).toEqual(original);
    expect(read).not.toBe(original);
    expect(Object.isFrozen(read)).toBe(true);
    expect(modelKeyAuditEvents()).not.toBe(modelKeyAuditEvents());
  });

  it("is emptied by a clear", () => {
    recordModelKeyEvent(event(1));
    clearModelKeyAuditEvents();
    expect(modelKeyAuditEvents()).toEqual([]);
  });
});
