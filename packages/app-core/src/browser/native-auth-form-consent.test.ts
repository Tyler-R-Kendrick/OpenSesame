// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reserveNativeAuthPopup } from "./native-auth-session.js";

const state = "a".repeat(64);
function request() {
  return {
    authorizationUrl: "https://idp.example/saml",
    state,
    expiresAt: Date.now() + 60000,
    fields: { SAMLRequest: "independently-signed-request", RelayState: state },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  document.head.replaceChildren();
  vi.spyOn(window, "open").mockReturnValue(window);
  vi.spyOn(window, "close").mockImplementation(() => undefined);
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(
    () => undefined,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("one-use native form consent reservation", () => {
  it("reserves synchronously and uses bounded hidden POST fields in the native DOM", () => {
    const popup = reserveNativeAuthPopup();
    expect(window.open).toHaveBeenCalledOnce();
    expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
    const consent = popup.showFormConsent(request());
    const form = document.querySelector("form");
    expect(form?.method).toBe("post");
    expect(form?.action).toBe("https://idp.example/saml");
    expect(form?.target).toBe("_self");
    expect(
      [...document.querySelectorAll("input")].every(
        (input) => input.type === "hidden",
      ),
    ).toBe(true);
    expect(Object.fromEntries(new FormData(form ?? undefined))).toEqual(
      request().fields,
    );
    expect(
      document.querySelector('meta[name="referrer"]')?.getAttribute("content"),
    ).toBe("no-referrer");
    expect(window.opener).toBeNull();
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledOnce();
    expect(consent.signal.aborted).toBe(false);
    consent.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps HTML-shaped values inert and a submit field cannot clobber the native method", () => {
    const value = '"><script>throw Error("executed")</script>';
    const consent = reserveNativeAuthPopup().showFormConsent({
      ...request(),
      fields: { submit: value },
    });
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("input")?.value).toBe(value);
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledOnce();
    consent.close();
  });
  it("cannot reuse a submitted reservation across any authorization mode", async () => {
    const popup = reserveNativeAuthPopup();
    const consent = popup.showFormConsent(request());
    expect(() => popup.showFormConsent(request())).toThrow("already used");
    await expect(
      popup.wait({ ...request(), redirectUri: "https://app.example/callback" }),
    ).rejects.toThrow("already used");
    expect(consent.signal.aborted).toBe(true);
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans up the deadline and cancellation listener after successful delivery", () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const consent = reserveNativeAuthPopup().showFormConsent({
      ...request(),
      signal: controller.signal,
    });
    consent.close();
    controller.abort();
    expect(consent.signal.aborted).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["owner", "reservation", "deadline"])(
    "cancels on %s and releases its timer",
    async (reason) => {
      const controller = new AbortController();
      const popup = reserveNativeAuthPopup();
      const consent = popup.showFormConsent({
        ...request(),
        signal: controller.signal,
      });
      if (reason === "owner") controller.abort();
      if (reason === "reservation") popup.cancel();
      if (reason === "deadline") await vi.advanceTimersByTimeAsync(60000);
      expect(consent.signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(window.close).toHaveBeenCalled();
    },
  );
  it("refuses a cancelled owner before any form submission", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      reserveNativeAuthPopup().showFormConsent({
        ...request(),
        signal: controller.signal,
      }),
    ).toThrow("cancelled");
    expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["owner", "reservation", "deadline"])(
    "refuses %s withdrawal from a field getter before native submission",
    (reason) => {
      const controller = new AbortController();
      const popup = reserveNativeAuthPopup();
      const input = { ...request(), signal: controller.signal };
      Object.defineProperty(input.fields, "SAMLRequest", {
        enumerable: true,
        get: () => {
          if (reason === "owner") {
            controller.abort();
            input.signal = new AbortController().signal;
          }
          if (reason === "reservation") popup.cancel();
          if (reason === "deadline") {
            vi.setSystemTime(input.expiresAt);
            input.expiresAt = Date.now() + 60000;
          }
          return "inert-request";
        },
      });
      expect(() => popup.showFormConsent(input)).toThrow(
        reason === "deadline" ? "expired" : "cancelled",
      );
      expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
      expect(document.querySelector("form")).toBeNull();
      expect(window.close).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(() => popup.showFormConsent(request())).toThrow("already used");
    },
  );
  it("keeps the original validated target when a field getter rewrites the request", () => {
    const input = request();
    Object.defineProperty(input.fields, "SAMLRequest", {
      enumerable: true,
      get: () => {
        input.authorizationUrl = "https://other.example/rewritten";
        input.state = "rewritten";
        return "inert-request";
      },
    });
    const consent = reserveNativeAuthPopup().showFormConsent(input);
    expect(document.querySelector("form")?.action).toBe(
      "https://idp.example/saml",
    );
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledOnce();
    expect(document.querySelector("input")?.value).toBe("inert-request");
    consent.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([undefined, null, 17, true, { unexpected: "value" }])(
    "refuses non-string field values without DOM coercion: %#",
    (value) => {
      const fields = { SAMLRequest: "placeholder" };
      Object.defineProperty(fields, "SAMLRequest", {
        enumerable: true,
        get: () => value,
      });
      const popup = reserveNativeAuthPopup();
      expect(() => popup.showFormConsent({ ...request(), fields })).toThrow();
      expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
      expect(document.querySelector("form")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each([
    { authorizationUrl: "http://idp.example/saml" },
    { authorizationUrl: "javascript:alert(1)" },
    { authorizationUrl: "https://user:password@idp.example/saml" },
    { authorizationUrl: "https://idp.example/saml#fragment" },
    { expiresAt: 0 },
    { expiresAt: Number.POSITIVE_INFINITY },
    { expiresAt: Number.NaN },
    { state: "short" },
    { fields: {} },
    { fields: { "bad-name": "value" } },
    {
      fields: Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [`field${i}`, "value"]),
      ),
    },
    { fields: { tooLarge: "a".repeat(393217) } },
    { fields: { utf8Bound: "🙂".repeat(150000) } },
  ])(
    "refuses malformed or unbounded form requests before native submission: %#",
    (change) => {
      const popup = reserveNativeAuthPopup();
      expect(() =>
        popup.showFormConsent({ ...request(), ...change }),
      ).toThrow();
      expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(() => popup.showFormConsent(request())).toThrow("already used");
    },
  );
});
