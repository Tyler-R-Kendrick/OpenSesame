/** @vitest-environment jsdom */
import { kvDelete } from "@opensesame/app-core/lib/kv.js";
import {
  PUSH_PENDING_FORGET_KEY,
  addPendingPushForget,
  pendingPushForgets,
} from "@opensesame/app-core/lib/push-ledger.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enablePush, flushPendingForgets } from "./push-enrolment.js";
import {
  ENROL,
  fetchFn,
  installSeams,
  json,
  keyReply,
  restoreSeams,
  worker,
} from "./push-enrolment.test-support.js";
import { pushSeams } from "./push-seams.js";

beforeEach(() => {
  installSeams();
  kvDelete(PUSH_PENDING_FORGET_KEY);
});
afterEach(restoreSeams);

describe("no call to the Identity API or the browser may hold the key for ever", () => {
  it("gives up on a service that accepts the connection and says nothing", async () => {
    worker(null);
    Object.assign(pushSeams, { requestTimeoutMs: 10 });
    let aborted = false;
    fetchFn.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    await expect(enablePush(ENROL)).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/not reachable/),
    });
    expect(aborted).toBe(true);
  });

  it("gives up on a body that never finishes arriving", async () => {
    worker(null);
    Object.assign(pushSeams, { requestTimeoutMs: 10 });
    fetchFn.mockImplementation(async (_url: string, init: RequestInit) => {
      const response = new Response("{}", { status: 200 });
      response.json = () =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("x")));
        });
      return response;
    });
    // The body fails to parse and reads as empty: no key, so not available.
    await expect(enablePush(ENROL)).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("gives up on a push service that never answers subscribe", async () => {
    Object.assign(pushSeams, { subscribeWaitMs: 10 });
    worker(
      null,
      vi.fn(() => new Promise(() => {})),
    );
    fetchFn.mockResolvedValueOnce(keyReply());
    await expect(enablePush(ENROL)).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/push service could not be reached/),
    });
  });
});

describe("ids the Identity API may still list", () => {
  it("are forgotten one by one and cleared as each is", async () => {
    addPendingPushForget("push_a");
    addPendingPushForget("push_b");
    fetchFn.mockResolvedValue(new Response(null, { status: 204 }));
    await flushPendingForgets(ENROL, null);
    expect(
      fetchFn.mock.calls.map((c) => String(c[0]).split("/").pop()),
    ).toEqual(["push_a", "push_b"]);
    expect(pendingPushForgets()).toEqual([]);
  });

  it("stay, with the rest, when the service cannot be reached, and nothing throws", async () => {
    addPendingPushForget("push_a");
    addPendingPushForget("push_b");
    fetchFn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(flushPendingForgets(ENROL, null)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(pendingPushForgets()).toEqual(["push_a", "push_b"]);
  });

  it("stay when the service refuses", async () => {
    addPendingPushForget("push_a");
    fetchFn.mockResolvedValueOnce(json({ error: "boom" }, 500));
    await flushPendingForgets(ENROL, null);
    expect(pendingPushForgets()).toEqual(["push_a"]);
  });

  it("never include the id this browser is using again", async () => {
    addPendingPushForget("push_live");
    await flushPendingForgets(ENROL, "push_live");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pendingPushForgets()).toEqual([]);
  });

  it("refuse anything that is not an opaque id", () => {
    addPendingPushForget("../../x");
    addPendingPushForget("a b");
    addPendingPushForget("");
    expect(pendingPushForgets()).toEqual([]);
  });
});
