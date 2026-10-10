import { afterEach, expect, it, vi } from "vitest";
import {
  type GoogleIdentitySdk,
  type GoogleTokenResponse,
  loadNativeGoogleSdk,
  requestNativeGoogleSdkConsent,
  revokeNativeGoogleSdkToken,
} from "./native-google-sdk.js";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function sdk(
  response: GoogleTokenResponse = {
    access_token: "minted-google-token",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid",
  },
) {
  const requestAccessToken = vi.fn();
  const initTokenClient = vi.fn<
    GoogleIdentitySdk["accounts"]["oauth2"]["initTokenClient"]
  >((options) => ({
    requestAccessToken: (request) => {
      requestAccessToken(request);
      options.callback(response);
    },
  }));
  const revoke = vi.fn<GoogleIdentitySdk["accounts"]["oauth2"]["revoke"]>(
    (_token, callback) => callback({ successful: true }),
  );
  return {
    sdk: { accounts: { oauth2: { initTokenClient, revoke } } },
    initTokenClient,
    requestAccessToken,
    revoke,
  };
}
const request = () => ({
  clientId: "actual-public-client",
  scopes: ["openid"],
  expiresAt: Date.now() + 60_000,
});
it("opens official GIS synchronously from the second click and returns its actual scopes/token", () => {
  const google = sdk();
  const receive = vi.fn();
  const fail = vi.fn();
  requestNativeGoogleSdkConsent(google.sdk, request(), receive, fail);
  expect(google.requestAccessToken).toHaveBeenCalledWith({ prompt: "consent" });
  expect(google.initTokenClient.mock.calls[0]?.[0]).toMatchObject({
    client_id: "actual-public-client",
    scope: "openid",
    include_granted_scopes: false,
  });
  expect(receive).toHaveBeenCalledWith(
    expect.objectContaining({
      accessToken: "minted-google-token",
      protocolValid: true,
      scopes: ["openid"],
    }),
  );
  expect(fail).not.toHaveBeenCalled();
});
it("preserves minted bearer material with malformed protocol for cleanup", () => {
  const google = sdk({
    access_token: "minted-malformed-token",
    token_type: "invalid",
    error: "invalid_response",
  });
  const receive = vi.fn();
  requestNativeGoogleSdkConsent(google.sdk, request(), receive, vi.fn());
  expect(receive).toHaveBeenCalledWith(
    expect.objectContaining({
      accessToken: "minted-malformed-token",
      protocolValid: false,
      expiresAt: null,
      scopes: null,
    }),
  );
});
it("distinguishes unminted denial from a malformed issued grant", () => {
  const google = sdk({ error: "access_denied" });
  const fail = vi.fn();
  const receive = vi.fn();
  requestNativeGoogleSdkConsent(google.sdk, request(), receive, fail);
  expect(receive).not.toHaveBeenCalled();
  expect(fail.mock.calls[0]?.[0].code).toBe("denied");
});
it("does not launch GIS after consent expires", () => {
  const google = sdk();
  const fail = vi.fn();
  requestNativeGoogleSdkConsent(
    google.sdk,
    { ...request(), expiresAt: Date.now() },
    vi.fn(),
    fail,
  );
  expect(google.initTokenClient).not.toHaveBeenCalled();
  expect(fail.mock.calls[0]?.[0].code).toBe("expired");
});
it("keeps strict isolation authoritative before SDK load", async () => {
  vi.stubGlobal("__NATIVE_GOOGLE_HEADER_SECURITY__", true);
  vi.stubGlobal("crossOriginIsolated", false);
  await expect(
    loadNativeGoogleSdk(new AbortController().signal),
  ).rejects.toThrow("public-browser");
});
it("bounds SDK loading and aborts without leaving a script callback", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("__NATIVE_GOOGLE_HEADER_SECURITY__", false);
  vi.stubGlobal("crossOriginIsolated", false);
  vi.stubGlobal("window", {});
  const script = { remove: vi.fn(), onload: null, onerror: null };
  const append = vi.fn();
  vi.stubGlobal("document", { createElement: () => script, head: { append } });
  const pending = loadNativeGoogleSdk(new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow("CORS");
  await vi.advanceTimersByTimeAsync(15000);
  await rejected;
  expect(script.remove).toHaveBeenCalledOnce();
  expect(script.onload).toBeNull();
  const lifetime = new AbortController();
  const cancelled = loadNativeGoogleSdk(lifetime.signal);
  const aborted = expect(cancelled).rejects.toThrow("expired");
  lifetime.abort();
  await aborted;
});
it("confirms actual provider revocation and reports unresolved cleanup", async () => {
  const google = sdk();
  await revokeNativeGoogleSdkToken(google.sdk, "issued-access");
  expect(google.revoke).toHaveBeenCalledWith(
    "issued-access",
    expect.any(Function),
  );
  google.revoke.mockImplementation((_token, callback) =>
    callback({ successful: false }),
  );
  await expect(
    revokeNativeGoogleSdkToken(google.sdk, "issued-access"),
  ).rejects.toThrow("cleanup");
});
