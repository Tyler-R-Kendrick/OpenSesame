import { afterEach, expect, it, vi } from "vitest";
import { requestNativeGoogleToken } from "../browser/native-google-oauth.js";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
  verifyNativeBrowserOAuthConnector,
} from "./native-browser-oauth-connectors.js";
import { readNativeConnector } from "./native-connector-store.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import {
  installNativeOAuthTests,
  oauthAuthority,
  oauthDraft,
} from "./native-oauth.test-support.js";

installNativeOAuthTests();
afterEach(() => vi.unstubAllGlobals());
function googleSdk(denied = false) {
  vi.stubGlobal("__NATIVE_GOOGLE_HEADER_SECURITY__", false);
  vi.stubGlobal("crossOriginIsolated", false);
  const initTokenClient = vi.fn<
    NonNullable<Window["google"]>["accounts"]["oauth2"]["initTokenClient"]
  >((options) => ({
    requestAccessToken: () =>
      options.callback(
        denied
          ? { error: "access_denied" }
          : {
              access_token: "private-google-sdk-access",
              token_type: "Bearer",
              expires_in: 1,
              scope: "openid https://www.googleapis.com/auth/userinfo.email",
            },
      ),
  }));
  vi.stubGlobal("window", {
    google: { accounts: { oauth2: { initTokenClient } } },
  });
  return initTokenClient;
}
it("Google SDK authorization seals its actual token and verifies userinfo; expiry requires a new popup rather than a fabricated refresh", async () => {
  const provider = oauthAuthority("google");
  const initTokenClient = googleSdk();
  const release = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: provider.navigate,
    scrubCallback: provider.scrubCallback,
    googleToken: requestNativeGoogleToken,
  });
  try {
    const draft = await configureNativeBrowserOAuthConnector(
      oauthDraft("google"),
    );
    provider.replies.push({
      body: {
        sub: "actual-google-user",
        email: "owner@example.test",
        name: "Google owner",
      },
    });
    await beginNativeBrowserAuthorization(draft.connectionId);
    const view = readNativeConnector(draft.connectionId);
    expect(view?.status).toBe("connected");
    expect(view?.identity).toMatchObject({
      id: "actual-google-user",
      label: "Google owner",
      assurance: "account-verified",
    });
    expect(initTokenClient.mock.calls[0]?.[0].client_id).toBe(
      "public-browser-client",
    );
    expect(String(provider.fetch.mock.calls[0]?.[0])).toBe(
      "https://openidconnect.googleapis.com/v1/userinfo",
    );
    expect(
      new Headers(provider.fetch.mock.calls[0]?.[1]?.headers).get(
        "authorization",
      ),
    ).toBe("Bearer private-google-sdk-access");
    expect(provider.navigate).not.toHaveBeenCalled();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2000);
    await expect(
      verifyNativeBrowserOAuthConnector(draft.connectionId),
    ).rejects.toThrow("expired");
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(readNativeConnector(draft.connectionId)?.status).toBe("reauthorize");
  } finally {
    release();
  }
});
it("authoritative Google SDK denial clears its unminted intent and permits another consent attempt", async () => {
  const provider = oauthAuthority("google");
  googleSdk(true);
  const release = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: provider.navigate,
    scrubCallback: provider.scrubCallback,
    googleToken: requestNativeGoogleToken,
  });
  try {
    const draft = await configureNativeBrowserOAuthConnector(
      oauthDraft("google"),
    );
    await expect(
      beginNativeBrowserAuthorization(draft.connectionId),
    ).rejects.toThrow("declined");
    expect(readNativeConnector(draft.connectionId)?.status).toBe(
      "configuration",
    );
    expect(readNativeConnector(draft.connectionId)?.recovery).toEqual([]);
    expect(provider.fetch).not.toHaveBeenCalled();
  } finally {
    release();
  }
});
