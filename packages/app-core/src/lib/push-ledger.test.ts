import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet, kvSet } from "./kv.js";
import {
  PUSH_PENDING_FORGET_KEY,
  PUSH_SUBSCRIPTION_KEY,
  addPendingPushForget,
  clearPendingPushForget,
  pendingPushForgets,
  retirePushSubscriptionId,
} from "./push-ledger.js";

beforeEach(() => {
  kvDelete(PUSH_SUBSCRIPTION_KEY);
  kvDelete(PUSH_PENDING_FORGET_KEY);
});

describe("the push ledger", () => {
  it("keeps ids to forget once each, in order, and clears them one by one", () => {
    addPendingPushForget("push_a");
    addPendingPushForget("push_b");
    addPendingPushForget("push_a");
    expect(pendingPushForgets()).toEqual(["push_a", "push_b"]);
    clearPendingPushForget("push_a");
    expect(pendingPushForgets()).toEqual(["push_b"]);
    clearPendingPushForget("push_b");
    expect(kvGet(PUSH_PENDING_FORGET_KEY)).toBeNull();
  });

  it("refuses anything that is not an opaque id, and ignores such lines already stored", () => {
    addPendingPushForget("https://push.example/endpoint");
    addPendingPushForget("a\nb");
    expect(pendingPushForgets()).toEqual([]);
    kvSet(PUSH_PENDING_FORGET_KEY, "push_ok\n../../x\n\npush two");
    expect(pendingPushForgets()).toEqual(["push_ok"]);
  });

  it("retires the live id: it leaves its slot and waits to be forgotten", async () => {
    kvSet(PUSH_SUBSCRIPTION_KEY, "push_1");
    await retirePushSubscriptionId();
    expect(kvGet(PUSH_SUBSCRIPTION_KEY)).toBeNull();
    expect(pendingPushForgets()).toEqual(["push_1"]);
    // Nothing to retire is not an error, and adds nothing.
    await retirePushSubscriptionId();
    expect(pendingPushForgets()).toEqual(["push_1"]);
  });
});
