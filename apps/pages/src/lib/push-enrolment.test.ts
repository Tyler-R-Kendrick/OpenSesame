/** @vitest-environment jsdom */
import { EgressDenied } from "@opensesame/app-core/lib/capabilities/egress.js";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PushError,
  enablePush,
  pushSeams,
  pushSubscribed,
  pushSupported,
} from "./push-enrolment.js";
import {
  ENROL,
  KEY_BYTES,
  fetchFn,
  installSeams,
  json,
  keyReply,
  recorded,
  restoreSeams,
  subscription,
  worker,
} from "./push-enrolment.test-support.js";

beforeEach(installSeams);
afterEach(restoreSeams);

describe("enrolment", () => {
  it("reports no support rather than pretending", async () => {
    Object.assign(pushSeams, {
      serviceWorkerContainer: () => null,
      pushApiAvailable: () => false,
    });
    expect(pushSupported()).toBe(false);
    await expect(enablePush(ENROL)).rejects.toBeInstanceOf(PushError);
  });

  it("refuses when notifications are blocked, and says requests still wait", async () => {
    worker(null);
    Object.assign(pushSeams, { requestPermission: async () => "denied" });
    await expect(enablePush(ENROL)).rejects.toThrow(
      /blocked for this site.*still wait for you in the app/,
    );
  });

  it("tells a dismissed prompt from a blocked site", async () => {
    worker(null);
    Object.assign(pushSeams, { requestPermission: async () => "default" });
    const refusal = await enablePush(ENROL).catch((caught) => caught);
    expect(refusal).toMatchObject({ code: "denied" });
    expect(refusal.message).toMatch(/not allowed for this site/);
    expect(refusal.message).not.toMatch(/blocked/);
  });

  it("fetches the VAPID key, subscribes user-visibly, and registers", async () => {
    const asked: { visible: boolean | undefined; key: number[] }[] = [];
    const subscribe = vi.fn(async (options: PushSubscriptionOptionsInit) => {
      const key: ArrayBuffer = overlapCast(options.applicationServerKey);
      asked.push({
        visible: options.userVisibleOnly,
        key: [...new Uint8Array(key)],
      });
      return subscription();
    });
    worker(null, subscribe);
    fetchFn.mockResolvedValueOnce(keyReply());
    fetchFn.mockResolvedValueOnce(recorded());

    const record = await enablePush({
      baseUrl: "https://id.example/",
      accessToken: "session-bearer",
      deviceLabel: "Laptop",
    });
    expect(record.id).toBe("push_1");

    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      "https://id.example/v1/notification-channels/push/key",
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.visible).toBe(true);
    expect(asked[0]?.key).toEqual(KEY_BYTES);

    const init: RequestInit = fetchFn.mock.calls[1]?.[1] ?? {};
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(
      "https://id.example/v1/notification-channels/push/subscriptions",
    );
    expect(JSON.parse(String(init.body ?? "{}"))).toEqual({
      endpoint: "https://push.example/endpoint/abc",
      keys: { p256dh: "cDI1NmRo", auth: "YXV0aA" },
      deviceLabel: "Laptop",
    });
  });

  it("reuses a subscription made with the server's current key instead of minting a second", async () => {
    const held = subscription();
    const { subscribe } = worker(held);
    fetchFn.mockResolvedValueOnce(keyReply());
    fetchFn.mockResolvedValueOnce(recorded());

    await enablePush(ENROL);
    expect(subscribe).not.toHaveBeenCalled();
    expect(held.unsubscribe).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("replaces a subscription made with a key the server has since rotated", async () => {
    const stale = subscription([1, 2, 3]);
    const fresh = subscription();
    const subscribe = vi.fn(async () => fresh);
    worker(stale, subscribe);
    fetchFn.mockResolvedValueOnce(keyReply());
    fetchFn.mockResolvedValueOnce(recorded());

    await enablePush(ENROL);
    expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps a subscription whose browser does not say what key it used", async () => {
    const { subscribe } = worker(subscription(null));
    fetchFn.mockResolvedValueOnce(keyReply());
    fetchFn.mockResolvedValueOnce(recorded());
    await enablePush(ENROL);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("says which party refused when the browser will not subscribe", async () => {
    const cases: [string, string, RegExp][] = [
      ["NotAllowedError", "denied", /blocked for this site/],
      ["AbortError", "unavailable", /push service could not be reached/],
      ["NetworkError", "unavailable", /push service could not be reached/],
      ["NotSupportedError", "unsupported", /cannot subscribe to push/],
      ["SecurityError", "unsupported", /cannot subscribe to push/],
      ["SomethingElse", "failed", /could not subscribe to push/],
    ];
    for (const [name, code, message] of cases) {
      const failure = Object.assign(new Error("boom"), { name });
      worker(
        null,
        vi.fn(async () => {
          throw failure;
        }),
      );
      fetchFn.mockReset();
      fetchFn.mockResolvedValueOnce(keyReply());
      const refusal = await enablePush(ENROL).catch((caught) => caught);
      expect(refusal, name).toBeInstanceOf(PushError);
      expect(refusal.code, name).toBe(code);
      expect(refusal.message, name).toMatch(message);
    }
  });

  it("takes back a subscription it made when the service did not record it", async () => {
    const made = subscription();
    worker(
      null,
      vi.fn(async () => made),
    );
    fetchFn.mockResolvedValueOnce(keyReply());
    fetchFn.mockResolvedValueOnce(json({ error: "boom" }, 500));
    await expect(enablePush(ENROL)).rejects.toThrow(/refused that \(500\)/);
    expect(made.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("leaves a subscription it did not make when the service did not record it", async () => {
    const held = subscription();
    worker(held);
    fetchFn.mockResolvedValueOnce(keyReply());
    fetchFn.mockResolvedValueOnce(json({ error: "boom" }, 500));
    await expect(enablePush(ENROL)).rejects.toBeInstanceOf(PushError);
    expect(held.unsubscribe).not.toHaveBeenCalled();
  });

  it("takes a fresh subscription when another principal holds this browser's endpoint (409)", async () => {
    const theirs = subscription();
    const mine = subscription();
    const subscribe = vi.fn(async () => mine);
    worker(theirs, subscribe);
    fetchFn.mockResolvedValueOnce(keyReply());
    fetchFn.mockResolvedValueOnce(
      json({ error: "endpoint_already_registered" }, 409),
    );
    fetchFn.mockResolvedValueOnce(recorded());

    const record = await enablePush(ENROL);
    expect(record.id).toBe("push_1");
    expect(theirs.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(mine.unsubscribe).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("leaves nothing subscribed when the fresh subscription is refused too", async () => {
    const theirs = subscription();
    const mine = subscription();
    worker(
      theirs,
      vi.fn(async () => mine),
    );
    fetchFn.mockResolvedValueOnce(keyReply());
    fetchFn.mockResolvedValueOnce(
      json({ error: "endpoint_already_registered" }, 409),
    );
    fetchFn.mockResolvedValueOnce(
      json({ error: "endpoint_already_registered" }, 409),
    );
    await expect(enablePush(ENROL)).rejects.toMatchObject({ code: "conflict" });
    expect(theirs.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mine.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not resubscribe when the principal is at its subscription limit (409)", async () => {
    const mine = subscription();
    const subscribe = vi.fn(async () => mine);
    worker(null, subscribe);
    fetchFn.mockResolvedValueOnce(keyReply());
    fetchFn.mockResolvedValueOnce(
      json({ error: "subscription_limit_reached" }, 409),
    );
    const refusal = await enablePush(ENROL).catch((caught) => caught);
    expect(refusal).toMatchObject({ code: "limit" });
    expect(refusal.message).toMatch(/refused that \(409\)/);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(mine.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("lets go of a subscription the browser already held when the principal is at its limit (409)", async () => {
    // The service lists nothing for it and will record no more: left held, the
    // row would read On over a subscription nothing can ring, and every retry
    // would meet the same 409.
    const held = subscription();
    const { subscribe } = worker(held);
    fetchFn.mockResolvedValueOnce(keyReply());
    fetchFn.mockResolvedValueOnce(
      json({ error: "subscription_limit_reached" }, 409),
    );
    await expect(enablePush(ENROL)).rejects.toMatchObject({ code: "limit" });
    expect(subscribe).not.toHaveBeenCalled();
    expect(held.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("leaves a held subscription alone for a refusal that may have left an enrolment working (401)", async () => {
    const held = subscription();
    worker(held);
    fetchFn.mockResolvedValueOnce(keyReply());
    fetchFn.mockResolvedValueOnce(json({ error: "unauthorized" }, 401));
    await expect(enablePush(ENROL)).rejects.toMatchObject({ code: "failed" });
    expect(held.unsubscribe).not.toHaveBeenCalled();
  });

  it("does not call a policy refusal the service being unreachable", async () => {
    worker(null);
    fetchFn.mockRejectedValueOnce(
      new EgressDenied(
        "purpose-not-declared",
        "notifications.web-push",
        "https://id.example/v1/notification-channels/push/key",
      ),
    );
    const refusal = await enablePush(ENROL).catch((caught) => caught);
    expect(refusal).toMatchObject({ code: "blocked" });
    expect(refusal.message).toMatch(/purpose-not-declared/);
    expect(refusal.message).not.toMatch(/not reachable/);
  });

  it("calls a network failure the service being unreachable", async () => {
    worker(null);
    fetchFn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(enablePush(ENROL)).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/not reachable/),
    });
  });
});

describe("the worker that receives the push", () => {
  it("waits for the push worker to take the scope before subscribing", async () => {
    const made = subscription();
    const subscribe = vi.fn(async () => made);
    const { registration } = worker(null, subscribe);
    let checks = 0;
    Object.assign(pushSeams, {
      workerIsPush: () => {
        checks += 1;
        return checks > 3;
      },
      pushWorkerWaitMs: 60_000,
    });
    fetchFn.mockResolvedValueOnce(keyReply());
    fetchFn.mockResolvedValueOnce(recorded());
    await enablePush(ENROL);
    expect(checks).toBe(4);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(registration).toBeDefined();
  });

  it("gives up with a clear message, and subscribes nothing, when it never does", async () => {
    const subscribe = vi.fn();
    worker(null, subscribe);
    Object.assign(pushSeams, {
      workerIsPush: () => false,
      pushWorkerWaitMs: 0,
    });
    await expect(enablePush(ENROL)).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/still being installed/),
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not wait for ever for a worker that is not registered", async () => {
    Object.assign(pushSeams, {
      serviceWorkerContainer: () =>
        overlapCast({ ready: new Promise(() => {}) }),
    });
    await expect(enablePush(ENROL)).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/No service worker is running/),
    });
    await expect(pushSubscribed()).resolves.toBe(false);
  });
});
