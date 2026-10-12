import { afterEach, expect, it, vi } from "vitest";
import { requestNativeGoogleToken } from "../browser/native-google-oauth.js";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
} from "./native-browser-oauth-connectors.js";
import type { IssuedNativeOAuthToken } from "./native-browser-oauth-token.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import * as session from "./native-oauth-session.js";
import {
  installNativeOAuthTests,
  oauthAuthority,
  oauthDraft,
} from "./native-oauth.test-support.js";
installNativeOAuthTests();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
for (const mode of ["cancel", "lock"] as const) {
  it(`retains Google's issued credential without activation when ${mode} occurs during durable journaling`, async () => {
    vi.stubGlobal("__NATIVE_GOOGLE_HEADER_SECURITY__", false);
    vi.stubGlobal("crossOriginIsolated", false);
    const provider = oauthAuthority("google");
    let cancelled = false;
    const release = bindNativeOAuthBrowserPort({
      redirectUri: "https://selfhost.example/auth/native-connector.html",
      navigate: provider.navigate,
      scrubCallback: provider.scrubCallback,
      googleToken: requestNativeGoogleToken,
      captureAuthorizationGuard: () => () => {
        if (cancelled) throw new NativeOAuthError("denied");
      },
      prepareImplicitAuthorization: async () => ({
        state: "encrypted-google-public-state",
        redirectUri: "https://selfhost.example/auth/native-google.html",
        close: vi.fn(),
        authorize: async (_url, options) => {
          const token: IssuedNativeOAuthToken = {
            accessToken: "known-issued-google-token",
            expiresAt: Date.now() + 3600_000,
            scopes: [
              "openid",
              "https://www.googleapis.com/auth/userinfo.email",
            ],
            protocolValid: true,
          };
          await options.retain(token);
          if (cancelled) throw new NativeOAuthError("denied");
          return token;
        },
      }),
    });
    let resume: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const journal = session.journalNativeOAuthGrant;
    vi.spyOn(session, "journalNativeOAuthGrant").mockImplementation(
      async (...args) => {
        entered();
        await blocked;
        return journal(...args);
      },
    );
    try {
      const draft = await configureNativeBrowserOAuthConnector(
        oauthDraft("google"),
      );
      const attempt = beginNativeBrowserAuthorization(draft.connectionId);
      const rejected = expect(attempt).rejects.toThrow(
        mode === "cancel" ? "declined" : "Disposed lease",
      );
      await reached;
      if (mode === "cancel") cancelled = true;
      else
        provider.assertCurrent.mockImplementation(() => {
          throw new Error("Disposed lease");
        });
      resume();
      await rejected;
      const record = loadNativeConnectorRecord(draft.connectionId);
      expect(record?.privateState.recovery[0]?.grant?.accessToken).toBe(
        "known-issued-google-token",
      );
      expect(record?.runtime.grants).toEqual([]);
      expect(record?.privateState.verification).toBeNull();
      expect(readNativeConnector(draft.connectionId)?.status).toBe("cleanup");
      expect(provider.fetch).not.toHaveBeenCalled();
    } finally {
      resume();
      release();
    }
  });
}
