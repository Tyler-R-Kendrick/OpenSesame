import { afterEach, expect, it, vi } from "vitest";
import { requestNativeGoogleToken } from "../browser/native-google-oauth.js";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
  verifyNativeBrowserOAuthConnector,
} from "./native-browser-oauth-connectors.js";
import type { IssuedNativeOAuthToken } from "./native-browser-oauth-token.js";
import { readNativeConnector } from "./native-connector-store.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  installNativeOAuthTests,
  oauthAuthority,
  oauthDraft,
} from "./native-oauth.test-support.js";

installNativeOAuthTests();
afterEach(() => vi.unstubAllGlobals());
function googleBridge(denied = false) {
  vi.stubGlobal("__NATIVE_GOOGLE_HEADER_SECURITY__", false);
  vi.stubGlobal("crossOriginIsolated", false);
  return vi.fn(async () => ({
    state: "encrypted-google-public-state",
    redirectUri: "https://selfhost.example/auth/native-google.html",
    close: vi.fn(),
    authorize: async (
      _url: string,
      options: { retain: (token: IssuedNativeOAuthToken) => Promise<void> },
    ) => {
      if (denied) throw new NativeOAuthError("denied");
      const token = {
        accessToken: "private-google-sdk-access",
        expiresAt: Date.now() + 1000,
        scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
        protocolValid: true,
      };
      await options.retain(token);
      return token;
    },
  }));
}

it("Google SDK authorization seals its actual token and verifies userinfo; expiry requires a new popup rather than a fabricated refresh", async () => {
  const provider = oauthAuthority("google");
  const prepare = googleBridge();
  const release = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: provider.navigate,
    scrubCallback: provider.scrubCallback,
    googleToken: requestNativeGoogleToken,
    prepareImplicitAuthorization: prepare,
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
    expect(prepare).toHaveBeenCalledWith("google");
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
  const prepare = googleBridge(true);
  const release = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: provider.navigate,
    scrubCallback: provider.scrubCallback,
    googleToken: requestNativeGoogleToken,
    prepareImplicitAuthorization: prepare,
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
