import { afterEach, expect, it, vi } from "vitest";
import {
  nativeGoogleBrowserAvailable,
  requestNativeGoogleToken,
} from "./native-google-oauth.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("uses the real GIS SDK token-client contract and retains its returned token before success", async () => {
  vi.stubGlobal("__NATIVE_GOOGLE_HEADER_SECURITY__", false);
  vi.stubGlobal("crossOriginIsolated", false);
  const received: string[] = [];
  const initTokenClient = vi.fn<
    NonNullable<Window["google"]>["accounts"]["oauth2"]["initTokenClient"]
  >((options) => ({
    requestAccessToken: (request) => {
      expect(request.prompt).toBe("consent");
      received.push("popup");
      options.callback({
        access_token: "actual-google-sdk-access",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid https://www.googleapis.com/auth/userinfo.email",
      });
    },
  }));
  vi.stubGlobal("window", {
    google: { accounts: { oauth2: { initTokenClient } } },
  });
  await requestNativeGoogleToken(
    "public-google-client",
    ["openid", "https://www.googleapis.com/auth/userinfo.email"],
    async (token) => {
      expect(token.accessToken).toBe("actual-google-sdk-access");
      expect(token.refreshToken).toBeUndefined();
      expect(token.scopes).toEqual([
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
      ]);
      expect(token.protocolValid).toBe(true);
      received.push("sealed");
    },
    () => received.push("lease"),
  );
  expect(initTokenClient.mock.calls[0]?.[0]).toMatchObject({
    client_id: "public-google-client",
    include_granted_scopes: false,
  });
  expect(received).toEqual(["lease", "popup", "sealed"]);
});
it("rejects strict isolation before loading or contacting the SDK", async () => {
  vi.stubGlobal("__NATIVE_GOOGLE_HEADER_SECURITY__", true);
  vi.stubGlobal("crossOriginIsolated", false);
  expect(nativeGoogleBrowserAvailable()).toBe(false);
  await expect(
    requestNativeGoogleToken(
      "client",
      [],
      async () => undefined,
      () => undefined,
    ),
  ).rejects.toThrow("Cross-Origin-Opener-Policy");
});
it("does not start a Google popup after the captured capability expires", async () => {
  vi.stubGlobal("__NATIVE_GOOGLE_HEADER_SECURITY__", false);
  vi.stubGlobal("crossOriginIsolated", false);
  const initTokenClient = vi.fn();
  vi.stubGlobal("window", {
    google: { accounts: { oauth2: { initTokenClient } } },
  });
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
  expect(initTokenClient).not.toHaveBeenCalled();
});
