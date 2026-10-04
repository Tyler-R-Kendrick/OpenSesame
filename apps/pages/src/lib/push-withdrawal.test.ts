/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PushError,
  disablePush,
  forgetPushSubscription,
  pushSeams,
} from "./push-enrolment.js";
import {
  ENROL,
  fetchFn,
  installSeams,
  json,
  restoreSeams,
  subscription,
  worker,
} from "./push-enrolment.test-support.js";

beforeEach(installSeams);
afterEach(restoreSeams);

describe("withdrawal", () => {
  it("withdraws by opaque id, never by the capability endpoint", async () => {
    const held = subscription();
    worker(held);
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));

    expect(await disablePush({ ...ENROL, subscriptionId: "push_1" })).toEqual({
      browser: true,
      server: true,
    });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://id.example/v1/notification-channels/push/subscriptions/push_1",
    );
    expect(init?.method).toBe("DELETE");
    // The endpoint is a capability URL: it is never sent back to be matched on.
    expect(String(url)).not.toContain("push.example");
    expect(String(init?.body ?? "")).not.toContain("push.example");
    expect(held.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("treats an already-forgotten subscription as the outcome it wanted", async () => {
    const held = subscription();
    worker(held);
    fetchFn.mockResolvedValueOnce(json({ error: "not_found" }, 404));

    expect(
      await disablePush({ ...ENROL, subscriptionId: "push_gone" }),
    ).toEqual({ browser: true, server: true });
    expect(held.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("stops delivering locally even when the server call fails", async () => {
    const held = subscription();
    worker(held);
    fetchFn.mockResolvedValueOnce(json({ error: "boom" }, 500));

    await expect(
      disablePush({ ...ENROL, subscriptionId: "push_1" }),
    ).rejects.toBeInstanceOf(PushError);
    expect(held.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("undoes the browser half even with no id to name on the server", async () => {
    const held = subscription();
    worker(held);
    expect(await disablePush(ENROL)).toEqual({ browser: true, server: false });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(held.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("undoes the browser half with no session to tell the server with, and says the server was not told", async () => {
    const held = subscription();
    worker(held);
    expect(await disablePush({ subscriptionId: "push_1" })).toEqual({
      browser: true,
      server: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(held.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when nothing was subscribed here and nothing is on the server", async () => {
    worker(null);
    expect(await disablePush(ENROL)).toEqual({ browser: false, server: false });
  });

  it("still tells the server when the browser has already lost the subscription", async () => {
    worker(null);
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await disablePush({ ...ENROL, subscriptionId: "push_1" })).toEqual({
      browser: false,
      server: true,
    });
    expect(String(fetchFn.mock.calls[0]?.[0])).toMatch(
      /subscriptions\/push_1$/,
    );
  });

  it("does not hang on a worker that is not registered, and still tells the server", async () => {
    Object.assign(pushSeams, {
      serviceWorkerContainer: () =>
        overlapCast({ ready: new Promise(() => {}) }),
    });
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await disablePush({ ...ENROL, subscriptionId: "push_1" })).toEqual({
      browser: false,
      server: true,
    });
  });

  it("lets the server forget one id on its own", async () => {
    fetchFn.mockResolvedValueOnce(json({ error: "not_found" }, 404));
    await expect(
      forgetPushSubscription(ENROL, "push/odd id"),
    ).resolves.toBeUndefined();
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      "https://id.example/v1/notification-channels/push/subscriptions/push%2Fodd%20id",
    );
  });
});
