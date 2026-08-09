import { beforeEach, describe, expect, it } from "vitest";
import { kvSet } from "./kv.js";
import {
  MAX_ATTEMPTS,
  MAX_QUEUE_LENGTH,
  QUEUE_TTL_MS,
  claimTokenLabel,
  enqueue,
  loadQueue,
  recordAttempt,
  saveQueue,
} from "./queue.js";

const KEY = "outbox.v1";

function plant(rows: unknown[]): void {
  kvSet(KEY, JSON.stringify(rows));
}

beforeEach(() => {
  saveQueue([]);
});

describe("offline outbox", () => {
  it("drops entries it cannot account for", () => {
    plant([
      // Every one of these would otherwise become a privileged call on flush.
      { kind: "device_approve" },
      {
        kind: "claim_complete",
        claimToken: "not-a-claim-token",
        id: "a",
        createdAt: new Date().toISOString(),
      },
      {
        kind: "transfer_everything",
        id: "b",
        createdAt: new Date().toISOString(),
      },
      {
        kind: "device_approve",
        userCode: "ABCD",
        id: "",
        createdAt: new Date().toISOString(),
      },
      {
        kind: "device_approve",
        userCode: "ABCD",
        id: "c",
        createdAt: "not a date",
      },
      "just a string",
      null,
      {
        kind: "device_approve",
        userCode: "GOOD",
        id: "d",
        createdAt: new Date().toISOString(),
      },
    ]);
    const kept = loadQueue();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ kind: "device_approve", userCode: "GOOD" });
  });

  it("forgets a queued ceremony once its tokens would be dead anyway", () => {
    const stale = new Date(Date.now() - QUEUE_TTL_MS - 1000).toISOString();
    plant([
      {
        kind: "claim_complete",
        claimToken: "osc_clm_x.secret",
        id: "old",
        createdAt: stale,
      },
      {
        kind: "claim_complete",
        claimToken: "osc_clm_y.secret",
        id: "new",
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(loadQueue().map((a) => a.id)).toEqual(["new"]);
  });

  it("stays a handful of pending ceremonies rather than a log", () => {
    for (let i = 0; i < MAX_QUEUE_LENGTH + 10; i += 1) {
      enqueue({ kind: "device_approve", userCode: `CODE-${i}` });
    }
    const queue = loadQueue();
    expect(queue).toHaveLength(MAX_QUEUE_LENGTH);
    // The newest survive; the oldest fall off the front.
    expect(queue.at(-1)).toMatchObject({
      userCode: `CODE-${MAX_QUEUE_LENGTH + 9}`,
    });
  });

  it("lets an item that cannot succeed drop itself instead of blocking the rest", () => {
    const stuck = enqueue({ kind: "device_approve", userCode: "STUCK" });
    enqueue({ kind: "device_approve", userCode: "FINE" });
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      recordAttempt(stuck.id);
    }
    expect(loadQueue().map((a) => a.id)).toEqual([
      loadQueue().find(
        (a) => a.kind === "device_approve" && a.userCode === "FINE",
      )!.id,
    ]);
  });

  it("shows the half of a claim token that is not the secret", () => {
    expect(claimTokenLabel("osc_clm_abc123.super-secret-part")).toBe(
      "osc_clm_abc123",
    );
    expect(claimTokenLabel("osc_clm_abc123.super-secret-part")).not.toContain(
      "secret",
    );
  });
});
