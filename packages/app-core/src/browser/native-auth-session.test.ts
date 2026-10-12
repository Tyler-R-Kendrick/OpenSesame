import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type NativeAuthAcknowledgement,
  type NativeAuthBroadcast,
  captureNativeAuthCode,
  nativeAuthChannel,
} from "./native-auth-message.js";
import { runNativeAuthReturn } from "./native-auth-return.js";
import { reserveNativeAuthPopup } from "./native-auth-session.js";

const origin = "https://app.example";
const redirectUri = `${origin}/auth/native-connector.html`;
const state = "a".repeat(64);
const otherState = "b".repeat(64);
const channels = new Set<Channel>();
type TestMessage = NativeAuthAcknowledgement | NativeAuthBroadcast;
class Channel {
  onmessage: ((event: Pick<MessageEvent<TestMessage>, "data">) => void) | null =
    null;
  constructor(readonly name: string) {
    channels.add(this);
  }
  postMessage(data: TestMessage) {
    for (const peer of channels) {
      if (peer !== this && peer.name === this.name)
        queueMicrotask(() => peer.onmessage?.({ data }));
    }
  }
  close() {
    channels.delete(this);
    this.onmessage = null;
  }
}
function browser(href = `${origin}/connections`) {
  const events = new EventTarget();
  const popup = {
    opener: {},
    closed: false,
    close: vi.fn(),
    location: { replace: vi.fn() },
  };
  const value = {
    location: new URL(href),
    history: { replaceState: vi.fn() },
    open: vi.fn<() => typeof popup | null>(() => popup),
    close: vi.fn(),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  vi.stubGlobal("window", value);
  return { value, popup, events };
}
function request(callbackState = state) {
  return {
    authorizationUrl: "https://provider.example/authorize",
    redirectUri,
    state: callbackState,
    expiresAt: Date.now() + 60_000,
  };
}
async function ready() {
  await vi.waitFor(() => expect(channels.size).toBeGreaterThan(0));
}
beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", Channel);
  vi.stubGlobal("crossOriginIsolated", false);
});
afterEach(() => {
  for (const channel of channels) channel.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("originating consent session", () => {
  it("scrubs the static callback and returns the code to the still-unlocked tab", async () => {
    const initiating = browser();
    const pending = reserveNativeAuthPopup().wait(request());
    await ready();
    expect(initiating.popup.opener).toBeNull();
    const callback = browser(`${redirectUri}?state=${state}&code=issued-code`);
    const delivery = runNativeAuthReturn();
    expect(callback.value.history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/auth/native-connector.html",
    );
    await expect(pending).resolves.toEqual({
      state,
      code: "issued-code",
      error: false,
    });
    await expect(delivery).resolves.toBe(true);
    expect(initiating.popup.close).toHaveBeenCalledOnce();
    expect(channels.size).toBe(0);
  });

  it("keeps two concurrent originating sessions separate", async () => {
    browser();
    const one = reserveNativeAuthPopup().wait(request());
    const two = reserveNativeAuthPopup().wait(request(otherState));
    await vi.waitFor(() => expect(channels.size).toBe(2));
    browser(`${redirectUri}?state=${otherState}&code=second-code`);
    const secondDelivery = runNativeAuthReturn();
    await expect(two).resolves.toMatchObject({ code: "second-code" });
    await expect(secondDelivery).resolves.toBe(true);
    browser(`${redirectUri}?state=${state}&code=first-code`);
    const firstDelivery = runNativeAuthReturn();
    await expect(one).resolves.toMatchObject({ code: "first-code" });
    await expect(firstDelivery).resolves.toBe(true);
  });

  it("does not interpret a severed COOP WindowProxy as a closed consent window", async () => {
    const initiating = browser();
    initiating.popup.closed = true;
    const pending = reserveNativeAuthPopup().wait(request());
    await ready();
    browser(`${redirectUri}?state=${state}&code=isolated-code`);
    const delivery = runNativeAuthReturn();
    await expect(pending).resolves.toMatchObject({ code: "isolated-code" });
    await expect(delivery).resolves.toBe(true);
  });

  it("ignores another callback route and cannot reuse a consumed reservation", async () => {
    browser();
    const reservation = reserveNativeAuthPopup();
    const pending = reservation.wait(request());
    await ready();
    const peer = new Channel(await nativeAuthChannel(state));
    peer.postMessage({
      kind: "authorization-code",
      redirectUri: `${origin}/auth/linear.html`,
      receipt: "c".repeat(64),
      state,
      code: "wrong-route",
      error: false,
    });
    await Promise.resolve();
    expect(channels.size).toBe(2);
    browser(`${redirectUri}?state=${state}&code=correct-route`);
    const delivery = runNativeAuthReturn();
    await expect(pending).resolves.toMatchObject({ code: "correct-route" });
    await expect(delivery).resolves.toBe(true);
    await expect(reservation.wait(request())).rejects.toThrow("already used");
  });

  it("cancels explicitly and removes the return listener", async () => {
    browser();
    const reservation = reserveNativeAuthPopup();
    const pending = reservation.wait(request());
    await ready();
    const failure = expect(pending).rejects.toThrow("cancelled or expired");
    reservation.cancel();
    await failure;
    expect(channels.size).toBe(0);
  });

  it("returns a denial without treating it as an issued code", async () => {
    browser();
    const pending = reserveNativeAuthPopup().wait(request());
    await ready();
    browser(`${redirectUri}?state=${state}&error=access_denied`);
    const delivery = runNativeAuthReturn();
    await expect(pending).resolves.toEqual({ state, code: null, error: true });
    await expect(delivery).resolves.toBe(true);
  });

  it("expires a consent request and removes all listeners", async () => {
    vi.useFakeTimers();
    browser();
    const pending = reserveNativeAuthPopup().wait({
      ...request(),
      expiresAt: Date.now() + 1000,
    });
    await ready();
    const failure = expect(pending).rejects.toThrow("cancelled or expired");
    await vi.advanceTimersByTimeAsync(1000);
    await failure;
    expect(channels.size).toBe(0);
  });

  it("aborts a pending authorization on capability disposal", async () => {
    browser();
    const controller = new AbortController();
    const pending = reserveNativeAuthPopup().wait({
      ...request(),
      signal: controller.signal,
    });
    await ready();
    const failure = expect(pending).rejects.toThrow("cancelled or expired");
    controller.abort();
    await failure;
    expect(channels.size).toBe(0);
  });

  it("scrubs a cold/replayed callback without booting an unrelated app session", async () => {
    vi.useFakeTimers();
    const callback = browser(
      `${redirectUri}?state=${state}&code=replayed-code`,
    );
    const delivery = runNativeAuthReturn();
    await ready();
    await vi.advanceTimersByTimeAsync(2500);
    await expect(delivery).resolves.toBe(false);
    expect(callback.value.history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/auth/native-connector.html",
    );
    expect(callback.value.close).not.toHaveBeenCalled();
    expect(channels.size).toBe(0);
  });

  it("fails before provider navigation when the user blocks popups", () => {
    const initiating = browser();
    initiating.value.open.mockReturnValue(null);
    expect(() => reserveNativeAuthPopup()).toThrow(
      "Allow the provider sign-in",
    );
    expect(initiating.popup.location.replace).not.toHaveBeenCalled();
  });

  it("refuses foreign callback origins and malformed provider returns", async () => {
    browser();
    await expect(
      reserveNativeAuthPopup().wait({
        ...request(),
        redirectUri: "https://other.example/auth/callback",
      }),
    ).rejects.toThrow("exact origin");
    expect(
      captureNativeAuthCode(
        new URL(`${redirectUri}?state=${state}&code=one&code=two`),
      ),
    ).toBeNull();
    expect(
      captureNativeAuthCode(
        new URL(`${redirectUri}?state=${state}&code=one&error=denied`),
      ),
    ).toBeNull();
    expect(
      captureNativeAuthCode(new URL(`${redirectUri}?state=short&code=one`)),
    ).toBeNull();
  });
});

describe("provider-native web_message.opener", () => {
  it("requires exact provider origin, popup source, and pending state", async () => {
    const initiating = browser();
    const pending = reserveNativeAuthPopup().waitWebMessage({
      ...request(),
      expectedOrigin: "https://vercel.com",
    });
    const message = (
      eventOrigin: string,
      source: typeof initiating.popup | null,
      callbackState: string,
    ) => {
      const event = new Event("message");
      Object.defineProperties(event, {
        origin: { value: eventOrigin },
        source: { value: source },
        data: { value: { state: callbackState, code: "provider-code" } },
      });
      initiating.events.dispatchEvent(event);
    };
    message("https://attacker.example", initiating.popup, state);
    message("https://vercel.com", null, state);
    message("https://vercel.com", initiating.popup, otherState);
    expect(initiating.popup.close).not.toHaveBeenCalled();
    message("https://vercel.com", initiating.popup, state);
    await expect(pending).resolves.toMatchObject({ code: "provider-code" });
  });

  it("refuses opener messaging under enforced browser isolation", async () => {
    browser();
    vi.stubGlobal("crossOriginIsolated", true);
    await expect(
      reserveNativeAuthPopup().waitWebMessage({
        ...request(),
        expectedOrigin: "https://vercel.com",
      }),
    ).rejects.toThrow("static callback");
  });
});

describe("provider-native device consent", () => {
  const deviceRequest = () => ({
    verificationUri:
      "https://www.twitch.tv/activate?public=true&device-code=ABCD1234",
    userCode: "ABCD1234",
    state,
    expiresAt: Date.now() + 20 * 60_000,
  });

  it("shares the cancellable lifecycle with encrypted implicit-consent redirects", () => {
    const initiating = browser();
    const popup = reserveNativeAuthPopup();
    const authorizationUrl = `${origin}/auth/native-google.html#public-request`;
    const consent = popup.showRedirectConsent({
      authorizationUrl,
      state,
      expiresAt: Date.now() + 60_000,
    });
    expect(initiating.popup.location.replace).toHaveBeenCalledWith(
      authorizationUrl,
    );
    expect(initiating.popup.opener).toBeNull();
    expect(channels.size).toBe(0);
    popup.cancel();
    expect(consent.signal.aborted).toBe(true);
  });

  it("uses the reserved window for the official verification URI without a return channel", () => {
    const initiating = browser();
    initiating.popup.closed = true;
    const consent = reserveNativeAuthPopup().showDeviceConsent(deviceRequest());
    expect(initiating.popup.location.replace).toHaveBeenCalledWith(
      deviceRequest().verificationUri,
    );
    expect(initiating.popup.opener).toBeNull();
    expect(consent.signal.aborted).toBe(false);
    expect(channels.size).toBe(0);
    consent.close();
    expect(consent.signal.aborted).toBe(false);
  });

  it("aborts polling when the initiating user cancels", () => {
    browser();
    const popup = reserveNativeAuthPopup();
    const consent = popup.showDeviceConsent(deviceRequest());
    const aborted = vi.fn();
    consent.signal.addEventListener("abort", aborted);
    popup.cancel();
    expect(consent.signal.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledOnce();
  });

  it("aborts polling and closes the consent window at the provider deadline", async () => {
    vi.useFakeTimers();
    const initiating = browser();
    const consent = reserveNativeAuthPopup().showDeviceConsent({
      ...deviceRequest(),
      expiresAt: Date.now() + 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(consent.signal.aborted).toBe(true);
    expect(initiating.popup.close).toHaveBeenCalledOnce();
  });

  it("clears the deadline after successful polling without aborting the completed grant", async () => {
    vi.useFakeTimers();
    browser();
    const consent = reserveNativeAuthPopup().showDeviceConsent({
      ...deviceRequest(),
      expiresAt: Date.now() + 1000,
    });
    consent.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(consent.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects insecure verification, malformed user codes, and excessive lifetimes", () => {
    const initiating = browser();
    expect(() =>
      reserveNativeAuthPopup().showDeviceConsent({
        ...deviceRequest(),
        verificationUri: "http://127.0.0.1/activate",
      }),
    ).toThrow("Invalid provider device");
    expect(() =>
      reserveNativeAuthPopup().showDeviceConsent({
        ...deviceRequest(),
        userCode: "bad code",
      }),
    ).toThrow("Invalid provider device");
    expect(() =>
      reserveNativeAuthPopup().showDeviceConsent({
        ...deviceRequest(),
        expiresAt: Date.now() + 31 * 60_000,
      }),
    ).toThrow("Invalid or expired");
    expect(initiating.popup.location.replace).not.toHaveBeenCalled();
  });
});
