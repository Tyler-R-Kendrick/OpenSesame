import { expect, it, vi } from "vitest";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
} from "./native-browser-oauth-connectors.js";
import { retryNativeConnectorCleanup } from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { bindNativeProviderTransport } from "./native-connector-transport.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  installNativeOAuthTests,
  oauthAuthority,
  oauthDraft,
} from "./native-oauth.test-support.js";
installNativeOAuthTests();
const token = {
  accessToken: "private-issued-discord",
  expiresAt: Date.now() + 3600000,
  scopes: ["identify"],
  protocolValid: true,
};
function replies(
  provider: ReturnType<typeof oauthAuthority>,
  clientId = "public-browser-client",
) {
  provider.replies.push(
    {
      body: {
        application: { id: clientId },
        user: { id: "12345" },
        scopes: ["identify"],
        expires: new Date(Date.now() + 3600000).toISOString(),
      },
    },
    {
      body: {
        id: "12345",
        username: "actual-discord-user",
        global_name: "Discord owner",
      },
    },
  );
}
it("uses approved implicit consent and seals the actual bearer before acknowledging its return", async () => {
  const provider = oauthAuthority("discord");
  const draft = await configureNativeBrowserOAuthConnector(
    oauthDraft("discord"),
  );
  replies(provider);
  const authorize = vi.fn(
    async (
      url: string,
      options: {
        expiresAt: number;
        retain: (issued: typeof token) => Promise<void>;
      },
    ) => {
      const consent = new URL(url);
      expect(consent.origin + consent.pathname).toBe(
        "https://discord.com/oauth2/authorize",
      );
      expect(consent.searchParams.get("response_type")).toBe("token");
      expect(consent.searchParams.has("client_secret")).toBe(false);
      await options.retain(token);
      expect(
        loadNativeConnectorRecord(draft.connectionId)?.privateState.recovery[0]
          ?.grant?.accessToken,
      ).toBe(token.accessToken);
      return token;
    },
  );
  const close = vi.fn();
  const dispose = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: vi.fn(),
    scrubCallback: vi.fn(),
    prepareImplicitAuthorization: async () => ({
      state: "e".repeat(64),
      redirectUri: "https://selfhost.example/auth/native-implicit.html",
      authorize,
      close,
    }),
  });
  try {
    await beginNativeBrowserAuthorization(draft.connectionId);
    expect(readNativeConnector(draft.connectionId)?.status).toBe("connected");
    expect(readNativeConnector(draft.connectionId)?.identity?.id).toBe("12345");
    expect(close).toHaveBeenCalled();
    expect(provider.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://discord.com/api/v10/oauth2/@me",
      "https://discord.com/api/v10/users/@me",
    ]);
  } finally {
    dispose();
  }
});
it("refuses tokens belonging to another Discord application and never reports them connected", async () => {
  const provider = oauthAuthority("discord");
  const draft = await configureNativeBrowserOAuthConnector(
    oauthDraft("discord"),
  );
  replies(provider, "other-app");
  const dispose = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: vi.fn(),
    scrubCallback: vi.fn(),
    prepareImplicitAuthorization: async () => ({
      state: "e".repeat(64),
      redirectUri: "https://selfhost.example/auth/native-implicit.html",
      authorize: async (_url, options) => {
        await options.retain(token);
        return token;
      },
      close: vi.fn(),
    }),
  });
  try {
    await expect(
      beginNativeBrowserAuthorization(draft.connectionId),
    ).rejects.toThrow();
    expect(readNativeConnector(draft.connectionId)?.status).not.toBe(
      "connected",
    );
  } finally {
    dispose();
  }
});
it("retains an unobserved return outcome without pretending provider consent was revoked", async () => {
  oauthAuthority("discord");
  const draft = await configureNativeBrowserOAuthConnector(
    oauthDraft("discord"),
  );
  const dispose = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: vi.fn(),
    scrubCallback: vi.fn(),
    prepareImplicitAuthorization: async () => ({
      state: "e".repeat(64),
      redirectUri: "https://selfhost.example/auth/native-implicit.html",
      authorize: async () => {
        throw new Error("Return was lost");
      },
      close: vi.fn(),
    }),
  });
  try {
    await expect(
      beginNativeBrowserAuthorization(draft.connectionId),
    ).rejects.toThrow();
    expect(
      readNativeConnector(draft.connectionId)?.configuration.parameters
        .authorization_outcome,
    ).toBe("exchange-unobserved");
    expect(
      loadNativeConnectorRecord(draft.connectionId)?.privateState.recovery[0]
        ?.kind,
    ).toBe("revoke");
  } finally {
    dispose();
  }
});
it("keeps an observed token recoverable but refuses activation when consent is canceled during its deferred handoff", async () => {
  const provider = oauthAuthority("discord");
  const draft = await configureNativeBrowserOAuthConnector(
    oauthDraft("discord"),
  );
  let release: () => void = () => undefined;
  const defer = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancelled = new AbortController();
  const dispose = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: vi.fn(),
    scrubCallback: vi.fn(),
    prepareImplicitAuthorization: async () => ({
      state: "e".repeat(64),
      redirectUri: "https://selfhost.example/auth/native-implicit.html",
      authorize: async (_url, options) => {
        await options.retain(token);
        await defer;
        if (cancelled.signal.aborted) throw new NativeOAuthError("denied");
        return token;
      },
      close: vi.fn(),
    }),
  });
  try {
    const rejected = expect(
      beginNativeBrowserAuthorization(draft.connectionId),
    ).rejects.toThrow("declined");
    await vi.waitFor(() =>
      expect(
        loadNativeConnectorRecord(draft.connectionId)?.privateState.recovery[0]
          ?.grant?.accessToken,
      ).toBe(token.accessToken),
    );
    cancelled.abort();
    release();
    await rejected;
    expect(readNativeConnector(draft.connectionId)?.status).toBe("cleanup");
    expect(
      loadNativeConnectorRecord(draft.connectionId)?.privateState.grants.user,
    ).toBeUndefined();
    expect(provider.fetch).not.toHaveBeenCalled();
    const cleared = await retryNativeConnectorCleanup(draft.connectionId);
    expect(cleared.status).toBe("configuration");
    expect(cleared.recovery).toEqual([]);
  } finally {
    dispose();
  }
});
it("refuses activation when Cancel arrives during actual provider verification after token handoff", async () => {
  const provider = oauthAuthority("discord");
  const draft = await configureNativeBrowserOAuthConnector(
    oauthDraft("discord"),
  );
  const cancelled = new AbortController();
  let release: () => void = () => undefined;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = vi.fn(async () => {
    await response;
    return new Response(
      JSON.stringify({
        application: { id: "public-browser-client" },
        user: { id: "12345" },
        scopes: ["identify"],
        expires: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
  });
  const transportDispose = bindNativeProviderTransport({
    fetch: request,
    assertCurrent: provider.assertCurrent,
  });
  const dispose = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: vi.fn(),
    scrubCallback: vi.fn(),
    captureAuthorizationGuard: () => () => {
      if (cancelled.signal.aborted) throw new NativeOAuthError("denied");
    },
    prepareImplicitAuthorization: async () => ({
      state: "e".repeat(64),
      redirectUri: "https://selfhost.example/auth/native-implicit.html",
      authorize: async (_url, options) => {
        await options.retain(token);
        return token;
      },
      close: vi.fn(),
    }),
  });
  try {
    const rejected = expect(
      beginNativeBrowserAuthorization(draft.connectionId),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    cancelled.abort();
    release();
    await rejected;
    expect(readNativeConnector(draft.connectionId)?.status).toBe("cleanup");
    expect(
      loadNativeConnectorRecord(draft.connectionId)?.privateState.grants.user,
    ).toBeUndefined();
    expect(
      loadNativeConnectorRecord(draft.connectionId)?.privateState.recovery[0]
        ?.grant?.accessToken,
    ).toBe(token.accessToken);
  } finally {
    dispose();
    transportDispose();
  }
});
