/** Original popup request boundary; Window double, not physical Chromium closure proof. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reserveNativeAuthPopup } from "./native-auth-session.js";
const NOW = 1_792_000_000_000;
function browser() {
  const events = new EventTarget();
  const popup = {
    opener: {},
    close: vi.fn(),
    location: { href: "about:blank", replace: vi.fn() },
  };
  vi.stubGlobal("window", {
    location: new URL("https://app.example/"),
    open: () => popup,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  });
  vi.stubGlobal("crossOriginIsolated", false);
  return popup;
}
function request(offset: number) {
  return {
    authorizationUrl: "https://provider.example/authorize",
    expectedOrigin: "https://provider.example",
    state: "a".repeat(64),
    expiresAt: NOW + offset,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each([1, 599999, 600000])(
  "admits %ims within the unchanged ten-minute request boundary",
  async (offset) => {
    const opened = browser();
    const popup = reserveNativeAuthPopup();
    const waiting = popup.waitWebMessage(request(offset));
    expect(opened.location.replace).toHaveBeenCalledExactlyOnceWith(
      "https://provider.example/authorize",
    );
    const cancelled = expect(waiting).rejects.toThrow(
      "Provider authorization was cancelled or expired",
    );
    popup.cancel();
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
  },
);
it.each([-1, 0, 630001])(
  "rejects %ims at the original request bounds with exact fixed reason",
  async (offset) => {
    const opened = browser();
    const pending = reserveNativeAuthPopup().waitWebMessage(request(offset));
    await expect(pending).rejects.toThrow(
      offset <= 0
        ? "Provider authorization request expired"
        : "Provider authorization request exceeds allowed lifetime",
    );
    expect(opened.location.replace).not.toHaveBeenCalled();
    expect(opened.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it.each([1, 1799999, 1800000])(
  "admits %ims within the unchanged thirty-minute device/redirect boundary",
  (offset) => {
    const opened = browser();
    const popup = reserveNativeAuthPopup();
    const consent = popup.showRedirectConsent(request(offset));
    expect(opened.location.replace).toHaveBeenCalledExactlyOnceWith(
      "https://provider.example/authorize",
    );
    consent.close();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it.each([-1, 0, 1830001])(
  "rejects %ims at the unchanged device/redirect bounds",
  (offset) => {
    const opened = browser();
    expect(() =>
      reserveNativeAuthPopup().showRedirectConsent(request(offset)),
    ).toThrow(
      offset <= 0
        ? "Provider authorization request expired"
        : "Provider authorization request exceeds allowed lifetime",
    );
    expect(opened.location.replace).not.toHaveBeenCalled();
    expect(opened.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it.each([
  "not a URL private-token",
  "https://operator:private-token@provider.example/authorize",
  "http://provider.example/authorize",
])(
  "rejects an invalid URL without exporting its value",
  async (authorizationUrl) => {
    const opened = browser();
    const outcome = await reserveNativeAuthPopup()
      .waitWebMessage({ ...request(60000), authorizationUrl })
      .then(
        () => "",
        (error) => String(error),
      );
    expect(outcome).toBe("Error: Invalid provider authorization URL");
    expect(outcome).not.toContain("private-token");
    expect(opened.location.replace).not.toHaveBeenCalled();
  },
);
it("preserves invalid-state rejection without exposing its source or an expiry number", async () => {
  const opened = browser();
  const outcome = await reserveNativeAuthPopup()
    .waitWebMessage({ ...request(60000), state: "private\nstate" })
    .then(
      () => "",
      (error) => String(error),
    );
  expect(outcome).toBe("Error: Invalid provider authorization state");
  expect(outcome).not.toContain(String(NOW));
  expect(outcome).not.toContain("private");
  expect(opened.location.replace).not.toHaveBeenCalled();
});
