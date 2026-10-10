import { afterEach, expect, it, vi } from "vitest";
import type { IssuedNativeOAuthToken } from "../lib/native-browser-oauth-token.js";
import { bindNativeOAuthBrowserPort } from "../lib/native-oauth-browser-port.js";
import {
  nativeGoogleBrowserAvailable,
  requestNativeGoogleToken,
} from "./native-google-oauth.js";
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function bridge() {
  vi.stubGlobal("__NATIVE_GOOGLE_HEADER_SECURITY__", false);
  vi.stubGlobal("crossOriginIsolated", false);
  const close = vi.fn();
  const authorize = vi.fn(
    async (
      _url: string,
      options: {
        expiresAt: number;
        retain: (token: IssuedNativeOAuthToken) => Promise<void>;
      },
    ) => {
      const token = {
        accessToken: "actual-google-sdk-access",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid"],
        protocolValid: true,
      };
      await options.retain(token);
      return token;
    },
  );
  const prepare = vi.fn(async () => ({
    state: "encrypted-public-state",
    redirectUri: "https://selfhost.example/auth/native-google.html",
    authorize,
    close,
  }));
  releases.push(
    bindNativeOAuthBrowserPort({
      redirectUri: "https://selfhost.example/auth/native-connector.html",
      navigate: vi.fn(),
      scrubCallback: vi.fn(),
      prepareImplicitAuthorization: prepare,
    }),
  );
  return { prepare, authorize, close };
}
it("uses reserved encrypted Google consent and retains the minted token before success", async () => {
  const consent = bridge();
  const retain = vi.fn(async () => undefined);
  const assertCurrent = vi.fn();
  await requestNativeGoogleToken(
    "public-client",
    ["openid"],
    retain,
    assertCurrent,
  );
  expect(consent.prepare).toHaveBeenCalledWith("google");
  const call = consent.authorize.mock.calls[0];
  if (!call) throw new Error("Google consent was not requested");
  const [raw, options] = call;
  const url = new URL(raw);
  const params = new URLSearchParams(url.hash.slice(1));
  expect(url.origin + url.pathname).toBe(
    "https://selfhost.example/auth/native-google.html",
  );
  expect(params.get("clientId")).toBe("public-client");
  expect(JSON.parse(params.get("scopes") ?? "null")).toEqual(["openid"]);
  expect(params.get("state")).toBe("encrypted-public-state");
  expect(Number(params.get("expiresAt"))).toBe(options.expiresAt);
  expect(options.expiresAt - Date.now()).toBeGreaterThan(590_000);
  expect(retain).toHaveBeenCalledWith(
    expect.objectContaining({ accessToken: "actual-google-sdk-access" }),
  );
  expect(consent.close).toHaveBeenCalledOnce();
});
it("rejects strict isolation before preparing any consent", async () => {
  const consent = bridge();
  vi.stubGlobal("__NATIVE_GOOGLE_HEADER_SECURITY__", true);
  expect(nativeGoogleBrowserAvailable()).toBe(false);
  await expect(
    requestNativeGoogleToken(
      "client",
      [],
      async () => undefined,
      () => undefined,
    ),
  ).rejects.toThrow("Cross-Origin-Opener-Policy");
  expect(consent.prepare).not.toHaveBeenCalled();
});
it("does not start consent after the captured activation expires", async () => {
  const consent = bridge();
  await expect(
    requestNativeGoogleToken(
      "client",
      [],
      async () => undefined,
      () => {
        throw new Error("Disposed lease");
      },
    ),
  ).rejects.toThrow("Disposed lease");
  expect(consent.prepare).not.toHaveBeenCalled();
});
it("closes a reserved consent when sealing fails", async () => {
  const consent = bridge();
  await expect(
    requestNativeGoogleToken(
      "client",
      ["openid"],
      async () => {
        throw new Error("Cannot seal");
      },
      () => undefined,
    ),
  ).rejects.toThrow("Cannot seal");
  expect(consent.close).toHaveBeenCalledOnce();
});
