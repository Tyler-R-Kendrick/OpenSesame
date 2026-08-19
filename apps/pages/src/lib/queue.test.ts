import { beforeEach, describe, expect, it } from "vitest";
import { kvGet, kvSet } from "./kv.js";
import {
  MAX_QUEUE_LENGTH,
  QUEUE_TTL_MS,
  clearStagedClaimTokens,
  dequeue,
  enqueue,
  loadQueue,
} from "./queue.js";

const KEY = "outbox.v1";

beforeEach(() => {
  kvSet(KEY, "[]");
  clearStagedClaimTokens();
});

describe("offline outbox", () => {
  it("keeps only bounded, live device approvals from durable storage", () => {
    kvSet(
      KEY,
      JSON.stringify([
        null,
        {
          kind: "device_approve",
          userCode: "",
          id: "bad",
          createdAt: new Date(),
        },
        {
          kind: "device_approve",
          userCode: "OLD",
          id: "old",
          createdAt: new Date(Date.now() - QUEUE_TTL_MS - 1).toISOString(),
        },
        {
          kind: "device_approve",
          userCode: "GOOD",
          id: "good",
          createdAt: new Date().toISOString(),
        },
      ]),
    );

    expect(loadQueue()).toEqual([
      expect.objectContaining({ id: "good", userCode: "GOOD" }),
    ]);
  });

  it("bounds pending device ceremonies", () => {
    for (let index = 0; index < MAX_QUEUE_LENGTH + 2; index += 1) {
      enqueue({ kind: "device_approve", userCode: `CODE-${index}` });
    }
    expect(loadQueue()).toHaveLength(MAX_QUEUE_LENGTH);
    expect(loadQueue().at(-1)).toMatchObject({
      userCode: `CODE-${MAX_QUEUE_LENGTH + 1}`,
    });
  });

  it("never persists a claim bearer and clears it on lock", () => {
    enqueue({
      kind: "claim_complete",
      userCode: "WORD-WORD",
      claimToken: "osc_clm_id.secret",
    });
    expect(loadQueue()).toHaveLength(1);
    expect(kvGet(KEY)).not.toContain("secret");

    clearStagedClaimTokens();
    expect(loadQueue()).toEqual([]);
  });
});

describe("offline outbox edge cases", () => {
  it("drops a corrupt or non-list durable payload", () => {
    kvSet(KEY, "{corrupt");
    expect(loadQueue()).toEqual([]);
    kvSet(KEY, JSON.stringify({ not: "a list" }));
    expect(loadQueue()).toEqual([]);
  });

  it("rewrites storage when an older build left claim rows on disk", () => {
    kvSet(
      KEY,
      JSON.stringify([
        {
          kind: "claim_complete",
          claimToken: "osc_clm_old.secret",
          id: "c1",
          createdAt: new Date().toISOString(),
        },
        {
          kind: "device_approve",
          userCode: "KEEP",
          id: "d1",
          createdAt: new Date().toISOString(),
        },
      ]),
    );

    expect(loadQueue().map((item) => item.id)).toEqual(["d1"]);
    expect(kvGet(KEY)).not.toContain("claim_complete");
    expect(kvGet(KEY)).not.toContain("secret");
  });

  it("dequeues staged claims and durable device approvals by id", () => {
    const claim = enqueue({
      kind: "claim_complete",
      claimToken: "osc_clm_x.secret",
    });
    const device = enqueue({ kind: "device_approve", userCode: "ABCD" });

    dequeue(claim.id);
    expect(loadQueue().map((item) => item.id)).toEqual([device.id]);

    dequeue(device.id);
    expect(loadQueue()).toEqual([]);
  });
});
