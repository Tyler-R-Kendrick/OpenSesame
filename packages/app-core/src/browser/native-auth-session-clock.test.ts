/**
 * `Date.now()` is a wall clock and can step back. Linear mints its request as
 * `createdAt + 10 min` (`linear-auth.ts`) and runs a durable write before the
 * reserved window is opened; a clock that steps back in between must neither
 * refuse that request (closing the window before it reaches the provider) nor
 * keep the window waiting past its lifetime.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reserveNativeAuthPopup } from "./native-auth-session.js";

const origin = "https://app.example";
const redirectUri = `${origin}/auth/linear.html`;
const authorizationUrl = "https://linear.app/oauth/authorize?actor=app";
const state = "c".repeat(64);
const LIFETIME = 10 * 60_000;

class Channel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: unknown[] = [];
  constructor(readonly name: string) {}
  postMessage(data: unknown) {
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
function message(error: unknown): string {
  return error instanceof Error ? error.message : "rejected";
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
  const outcome = pending.then(() => "settled", message);
  const first = await Promise.race([
    outcome,
    vi
      .waitFor(() => expect(popup.location.replace).toHaveBeenCalledOnce())
      .then(() => "navigated"),
  ]);
  expect(first).toBe("navigated");
  expect(popup.location.replace).toHaveBeenCalledWith(authorizationUrl);
  expect(popup.close).not.toHaveBeenCalled();
  reservation.cancel();
  await expect(outcome).resolves.toBe(
    "Provider authorization was cancelled or expired",
  );
});

it("still closes the window at its lifetime when the clock stepped back", async () => {
  vi.useFakeTimers();
  const popup = browser();
  const createdAt = Date.now();
  vi.setSystemTime(createdAt - 20_000);
  let failure = "";
  reserveNativeAuthPopup()
    .wait(minted(createdAt))
    .catch((error: unknown) => {
      failure = message(error);
    });
  await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(LIFETIME);
  expect(failure).toBe("Provider authorization was cancelled or expired");
  expect(popup.close).toHaveBeenCalled();
});

it("still refuses a request minted for longer than its lifetime", async () => {
  const popup = browser();
  await expect(
    reserveNativeAuthPopup().wait(minted(Date.now(), LIFETIME + 60_000)),
  ).rejects.toThrow("Invalid or expired");
  expect(popup.location.replace).not.toHaveBeenCalled();
  expect(popup.close).toHaveBeenCalledOnce();
});
