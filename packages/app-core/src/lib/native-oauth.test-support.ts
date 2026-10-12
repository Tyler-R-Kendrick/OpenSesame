import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, vi } from "vitest";
import { installNativeApiTests } from "./native-api.test-support.js";
import { nativeBrowserOAuthCleanup } from "./native-browser-oauth-cleanup.js";
import { requiredBrowserOAuthProfile } from "./native-browser-oauth-profile.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import { registerNativeProviderCleanup } from "./native-connector-lifecycle.js";
import { loadNativeConnectorRecord } from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  bindNativeProviderTransport,
} from "./native-connector-transport.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";

const activeDisposers: (() => void)[] = [];
export function installNativeOAuthTests(): void {
  installNativeApiTests();
  afterEach(() => {
    for (const dispose of activeDisposers.splice(0).reverse()) dispose();
    vi.useRealTimers();
  });
}
export function oauthDraft(providerId = "gitlab"): NativeDriverInput {
  return {
    providerId,
    displayName: "My provider connection",
    method: "oauth",
    parameters: { client_id: "public-browser-client" },
    credentials: {},
    requestedScopes: {
      user: [...requiredBrowserOAuthProfile(providerId).requiredScopes],
    },
    targetIds: {},
  };
}
export function oauthPending(id: string) {
  const value = loadNativeConnectorRecord(id)?.privateState.pending.user;
  if (!value) throw new Error("Expected a sealed authorization transaction");
  return value;
}
export function oauthCallback(id: string): string {
  return new URLSearchParams({
    native_state: oauthPending(id).state,
    native_code: "one-use-provider-code",
  }).toString();
}
export function oauthAuthority(providerId = "gitlab") {
  const replies: { body: BoundaryValue; status?: number }[] = [];
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const reply = replies.shift();
    if (!reply) throw new Error("No provider response queued");
    return new Response(reply.body === null ? "" : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  const assertCurrent = vi.fn();
  const transport: NativeProviderTransport = { fetch, assertCurrent };
  const navigate = vi.fn();
  const scrubCallback = vi.fn();
  const disposers = [
    bindNativeProviderTransport(transport),
    bindNativeOAuthBrowserPort({
      redirectUri: "https://selfhost.example/auth/native-connector.html",
      navigate,
      scrubCallback,
    }),
    registerNativeProviderCleanup(providerId, nativeBrowserOAuthCleanup),
  ];
  activeDisposers.push(...disposers);
  return { replies, fetch, assertCurrent, transport, navigate, scrubCallback };
}
export const oauthToken = (scope = "read_user") => ({
  access_token: "private-issued-access",
  refresh_token: "private-issued-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope,
});
export const gitlabAccount = {
  id: 7,
  username: "actual-user",
  name: "Verified GitLab user",
};
