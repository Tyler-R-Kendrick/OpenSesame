/**
 * `Date.now()` is a wall clock and can step back. Linear mints its request as
 * `createdAt + 10 min` (`linear-auth.ts`) and runs a durable write before the
 * reserved window is opened; a clock that steps back in between must neither
 * refuse that request (closing the window before it reaches the provider) nor
 * keep the window waiting past its lifetime.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  NativeAuthAcknowledgement,
  NativeAuthBroadcast,
} from "./native-auth-message.js";
import { reserveNativeAuthPopup } from "./native-auth-session.js";

const origin = "https://app.example";
const redirectUri = `${origin}/auth/linear.html`;
const authorizationUrl = "https://linear.app/oauth/authorize?actor=app";
const state = "c".repeat(64);
const LIFETIME = 10 * 60_000;
const CANCELLED = "Provider authorization was cancelled or expired";

type TestMessage = NativeAuthAcknowledgement | NativeAuthBroadcast;
class Channel {
  onmessage: ((event: Pick<MessageEvent<TestMessage>, "data">) => void) | null =
    null;
  readonly sent: TestMessage[] = [];
  constructor(readonly name: string) {}
  postMessage(data: TestMessage) {
    this.sent.push(data);
  }
  close() {
    this.onmessage = null;
  }
}
function browser() {
  const popup = {
    opener: {},
    closed: false,
    close: vi.fn(),
    location: { href: "about:blank", replace: vi.fn() },
  };
  vi.stubGlobal("window", {
    location: new URL(`${origin}/connections/linear`),
    open: vi.fn(() => popup),
  });
  return popup;
}
function minted(createdAt: number, lifetime = LIFETIME) {
  return {
    authorizationUrl,
    redirectUri,
    state,
    expiresAt: createdAt + lifetime,
  };
}

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", Channel);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("opens the reserved window when the clock steps back after the request was minted", async () => {
  const popup = browser();
  const createdAt = Date.now();
  const reservation = reserveNativeAuthPopup();
  const clock = vi.spyOn(Date, "now").mockReturnValue(createdAt - 1);
  const pending = reservation.wait(minted(createdAt));
  clock.mockRestore();
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.waitFor(() => {
    expect(settled).toBe(false);
    expect(popup.location.replace).toHaveBeenCalledOnce();
  });
  expect(popup.location.replace).toHaveBeenCalledWith(authorizationUrl);
  expect(popup.close).not.toHaveBeenCalled();
  reservation.cancel();
  await expect(pending).rejects.toThrow(CANCELLED);
});

it("still closes the window at its lifetime when the clock stepped back", async () => {
  vi.useFakeTimers();
  const popup = browser();
  const createdAt = Date.now();
  vi.setSystemTime(createdAt - 20_000);
  const pending = reserveNativeAuthPopup().wait(minted(createdAt));
  let outcome = "pending";
  pending.then(
    () => {
      outcome = "resolved";
    },
    () => {
      outcome = "rejected";
    },
  );
  await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(LIFETIME);
  expect(outcome).toBe("rejected");
  await expect(pending).rejects.toThrow(CANCELLED);
  expect(popup.close).toHaveBeenCalled();
});

it("still refuses a request minted for longer than its lifetime", async () => {
  const popup = browser();
  await expect(
    reserveNativeAuthPopup().wait(minted(Date.now(), LIFETIME + 60_000)),
  ).rejects.toThrow("exceeds allowed lifetime");
  expect(popup.location.replace).not.toHaveBeenCalled();
  expect(popup.close).toHaveBeenCalledOnce();
});
