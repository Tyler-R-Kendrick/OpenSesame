/** @vitest-environment jsdom */
import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import { kvDelete, kvGet, kvSet } from "@opensesame/app-core/lib/kv.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  PUSH_PENDING_FORGET_KEY,
  pendingPushForgets,
} from "@opensesame/app-core/lib/push-ledger.js";
import { overlapCast } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../bindings/identity.js";
import { pushSeams } from "../../lib/push-enrolment.js";
import { PUSH_SUBSCRIPTION_KEY, PushPanel } from "./PushPanel.js";

const originalPush = { ...pushSeams };
const originalRemote = deviceIdentitySeams.remoteIdentityApi;
const originalSession = identityHookSeams.useIdentitySession;

const reply = (body: string) => new Response(body, { status: 200 });

const SUBSCRIPTION = {
  endpoint: "https://push.example/endpoint/abc",
  toJSON: () => ({
    endpoint: "https://push.example/endpoint/abc",
    keys: { p256dh: "cDI1NmRo", auth: "YXV0aA" },
  }),
  unsubscribe: vi.fn(async () => {
    held = null;
    return true;
  }),
};

let held: typeof SUBSCRIPTION | null = null;
const subscribed = { count: 0, hang: false };
const fetchFn = vi.fn();

function install({ supported = true } = {}) {
  Object.assign(pushSeams, {
    fetchFn,
    pushApiAvailable: () => supported,
    serviceWorkerContainer: () =>
      supported
        ? overlapCast({
            ready: Promise.resolve({
              pushManager: {
                getSubscription: async () => held,
                subscribe: async () => {
                  subscribed.count += 1;
                  if (subscribed.hang) return new Promise<never>(() => {});
                  held = SUBSCRIPTION;
                  return SUBSCRIPTION;
                },
              },
            }),
          })
        : null,
    requestPermission: async () => "granted" as const,
  });
}

function show() {
  return render(<PushPanel baseUrl={() => "https://id.example"} />);
}

beforeEach(() => {
  held = null;
  subscribed.count = 0;
  subscribed.hang = false;
  fetchFn.mockReset();
  SUBSCRIPTION.unsubscribe.mockClear();
  kvDelete(PUSH_SUBSCRIPTION_KEY);
  kvDelete(PUSH_PENDING_FORGET_KEY);
  clearNotices();
  deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
  identityHookSeams.useIdentitySession = () =>
    overlapCast({ accessToken: "t", issuerOrigin: "https://id.example" });
  install();
});

afterEach(() => {
  cleanup();
  Object.assign(pushSeams, originalPush);
  deviceIdentitySeams.remoteIdentityApi = originalRemote;
  identityHookSeams.useIdentitySession = originalSession;
});

describe("Push on this device", () => {
  it("turns push on with one key, remembers the id, and turns it off again", async () => {
    fetchFn.mockResolvedValueOnce(reply('{"publicKey":"cHVibGlja2V5"}'));
    fetchFn.mockResolvedValueOnce(reply('{"id":"push_1","createdAt":"x"}'));
    show();
    expect(await screen.findByRole("img", { name: "Off" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on push on this device" }),
    );
    expect(await screen.findByRole("img", { name: "On" })).toBeTruthy();
    expect(kvGet(PUSH_SUBSCRIPTION_KEY)).toBe("push_1");

    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fireEvent.click(
      screen.getByRole("button", { name: "Turn off push on this device" }),
    );
    expect(await screen.findByRole("img", { name: "Off" })).toBeTruthy();
    expect(String(fetchFn.mock.calls.at(-1)?.[0])).toBe(
      "https://id.example/v1/notification-channels/push/subscriptions/push_1",
    );
    expect(SUBSCRIPTION.unsubscribe).toHaveBeenCalledTimes(1);
    expect(kvGet(PUSH_SUBSCRIPTION_KEY)).toBeNull();
  });

  it("reads a subscription the browser already holds as On", async () => {
    held = SUBSCRIPTION;
    show();
    expect(await screen.findByRole("img", { name: "On" })).toBeTruthy();
  });

  it("keeps the row and its one key while the browser is still subscribed with no Identity API or session, so push can always be turned off", async () => {
    held = SUBSCRIPTION;
    deviceIdentitySeams.remoteIdentityApi = () => "";
    identityHookSeams.useIdentitySession = () => null;
    const view = show();
    expect(await screen.findByRole("img", { name: "On" })).toBeTruthy();
    kvSet(PUSH_SUBSCRIPTION_KEY, "push_1");
    fireEvent.click(
      screen.getByRole("button", { name: "Turn off push on this device" }),
    );
    await waitFor(() =>
      expect(SUBSCRIPTION.unsubscribe).toHaveBeenCalledTimes(1),
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(kvGet(PUSH_SUBSCRIPTION_KEY)).toBeNull();
    // Off with nothing to turn it on again: the row is gone, and says why.
    await waitFor(() => expect(view.container.textContent).toBe(""));
    expect(
      listNotices().find((notice) => notice.id === "push-on-this-device"),
    ).toMatchObject({ tone: "warn" });
  });

  it("says the service was not told when the subscription's id is not known", async () => {
    held = SUBSCRIPTION;
    show();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Turn off push on this device",
      }),
    );
    expect(await screen.findByRole("img", { name: "Off" })).toBeTruthy();
    expect(SUBSCRIPTION.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(
      listNotices().find((notice) => notice.id === "push-on-this-device")?.body,
    ).toMatch(/not told/);
  });

  it("says nothing when the service was told", async () => {
    held = SUBSCRIPTION;
    kvSet(PUSH_SUBSCRIPTION_KEY, "push_1");
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
    show();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Turn off push on this device",
      }),
    );
    expect(await screen.findByRole("img", { name: "Off" })).toBeTruthy();
    expect(listNotices()).toEqual([]);
  });

  it("reports a refusal as a tray notice and leaves the row's mark true", async () => {
    Object.assign(pushSeams, { requestPermission: async () => "denied" });
    show();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Turn on push on this device",
      }),
    );
    await waitFor(() =>
      expect(
        listNotices().find((notice) => notice.id === "push-on-this-device")
          ?.body,
      ).toMatch(/blocked for this site/),
    );
    expect(screen.getByRole("img", { name: "Off" })).toBeTruthy();
    expect(document.querySelector(".note")).toBeNull();
  });

  it("draws nothing without an Identity API, without a session, or in a browser that cannot receive push", async () => {
    deviceIdentitySeams.remoteIdentityApi = () => "";
    const none = show();
    await Promise.resolve();
    expect(none.container.textContent).toBe("");
    none.unmount();

    deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
    identityHookSeams.useIdentitySession = () => null;
    const signedOut = show();
    await Promise.resolve();
    expect(signedOut.container.textContent).toBe("");
    signedOut.unmount();

    identityHookSeams.useIdentitySession = () =>
      overlapCast({ accessToken: "t", issuerOrigin: "https://id.example" });
    install({ supported: false });
    const unsupported = show();
    await Promise.resolve();
    expect(unsupported.container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("turns push on once however fast the key is pressed", async () => {
    fetchFn.mockResolvedValueOnce(reply('{"publicKey":"cHVibGlja2V5"}'));
    fetchFn.mockResolvedValueOnce(reply('{"id":"push_1","createdAt":"x"}'));
    show();
    const key = await screen.findByRole("button", {
      name: "Turn on push on this device",
    });
    fireEvent.click(key);
    fireEvent.click(key);
    fireEvent.click(key);
    expect(await screen.findByRole("img", { name: "On" })).toBeTruthy();
    expect(subscribed.count).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("leaves the row Off, and the browser unsubscribed, when the service could not record it", async () => {
    fetchFn.mockResolvedValueOnce(reply('{"publicKey":"cHVibGlja2V5"}'));
    fetchFn.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    show();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Turn on push on this device",
      }),
    );
    await waitFor(() =>
      expect(
        listNotices().find((notice) => notice.id === "push-on-this-device"),
      ).toMatchObject({ tone: "err", body: expect.stringMatching(/500/) }),
    );
    expect(await screen.findByRole("img", { name: "Off" })).toBeTruthy();
    expect(SUBSCRIPTION.unsubscribe).toHaveBeenCalledTimes(1);
    expect(held).toBeNull();
  });

  it("asks the service to forget an id the browser no longer holds when push is turned on again", async () => {
    kvSet(PUSH_SUBSCRIPTION_KEY, "push_old");
    fetchFn.mockResolvedValueOnce(reply('{"publicKey":"cHVibGlja2V5"}'));
    fetchFn.mockResolvedValueOnce(reply('{"id":"push_new","createdAt":"x"}'));
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
    show();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Turn on push on this device",
      }),
    );
    expect(await screen.findByRole("img", { name: "On" })).toBeTruthy();
    expect(kvGet(PUSH_SUBSCRIPTION_KEY)).toBe("push_new");
    const [url, init] = fetchFn.mock.calls.at(-1) ?? [];
    expect(String(url)).toBe(
      "https://id.example/v1/notification-channels/push/subscriptions/push_old",
    );
    expect(init?.method).toBe("DELETE");
  });

  it("keeps the id of a subscription it could not withdraw, and withdraws it the next time the row can reach the service", async () => {
    held = SUBSCRIPTION;
    kvSet(PUSH_SUBSCRIPTION_KEY, "push_1");
    fetchFn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const view = show();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Turn off push on this device",
      }),
    );
    expect(await screen.findByRole("img", { name: "Off" })).toBeTruthy();
    expect(kvGet(PUSH_SUBSCRIPTION_KEY)).toBeNull();
    expect(pendingPushForgets()).toEqual(["push_1"]);

    // The row is shown again (a new visit to Settings): it tells the service.
    view.unmount();
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
    show();
    await waitFor(() => expect(pendingPushForgets()).toEqual([]));
    expect(String(fetchFn.mock.calls.at(-1)?.[0])).toMatch(
      /subscriptions\/push_1$/,
    );
  });

  it("keeps a stale id to forget when the first attempt fails, instead of losing it", async () => {
    kvSet(PUSH_SUBSCRIPTION_KEY, "push_old");
    fetchFn.mockResolvedValueOnce(reply('{"publicKey":"cHVibGlja2V5"}'));
    fetchFn.mockResolvedValueOnce(reply('{"id":"push_new","createdAt":"x"}'));
    fetchFn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    show();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Turn on push on this device",
      }),
    );
    expect(await screen.findByRole("img", { name: "On" })).toBeTruthy();
    expect(kvGet(PUSH_SUBSCRIPTION_KEY)).toBe("push_new");
    expect(pendingPushForgets()).toEqual(["push_old"]);
  });

  it("releases the key when the browser never answers, so it can be pressed again", async () => {
    Object.assign(pushSeams, { subscribeWaitMs: 20 });
    subscribed.hang = true;
    fetchFn.mockResolvedValue(reply('{"publicKey":"cHVibGlja2V5"}'));
    show();
    const key = await screen.findByRole("button", {
      name: "Turn on push on this device",
    });
    fireEvent.click(key);
    expect(key.getAttribute("aria-busy")).toBe("true");
    await waitFor(() =>
      expect(
        listNotices().find((notice) => notice.id === "push-on-this-device"),
      ).toMatchObject({ tone: "err" }),
    );
    await waitFor(() => expect(key.getAttribute("aria-busy")).toBeNull());
    subscribed.hang = false;
    fetchFn.mockResolvedValueOnce(reply('{"publicKey":"cHVibGlja2V5"}'));
    fetchFn.mockResolvedValueOnce(reply('{"id":"push_1","createdAt":"x"}'));
    fireEvent.click(key);
    expect(await screen.findByRole("img", { name: "On" })).toBeTruthy();
  });
});
