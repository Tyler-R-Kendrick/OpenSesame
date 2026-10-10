import { vi } from "vitest";
import * as kv from "./kv.js";
import { nativeBrowserOAuthCleanup } from "./native-browser-oauth-cleanup.js";
import { configureNativeBrowserOAuthConnector } from "./native-browser-oauth-config.js";
import { registerNativeProviderCleanup } from "./native-connector-lifecycle.js";
import { bindNativeProviderTransport } from "./native-connector-transport.js";
import type { NativeOAuthDeviceConsentRequest } from "./native-oauth-browser-port.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";

export const deviceCode = "private-device-code-01234567890123456789";
export const access = "test-issued-twitch-access-token";
export const refresh = "test-issued-twitch-refresh-token";
export const clientId = "public-twitch-client-id";
export const challenge = {
  device_code: deviceCode,
  user_code: "ABCDEFGH",
  expires_in: 1800,
  interval: 5,
  verification_uri:
    "https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH",
};
export const token = {
  access_token: access,
  refresh_token: refresh,
  token_type: "bearer",
  expires_in: 14400,
  scope: [],
};
export const disposers: (() => void)[] = [];
export function backend() {
  const memory = new Map<string, string>();
  const disk = new Map<string, string>();
  vi.spyOn(kv.kvSeams, "kvGet").mockImplementation(
    (key) => memory.get(key) ?? null,
  );
  vi.spyOn(kv.kvSeams, "kvSetDurable").mockImplementation(
    async (key, value) => {
      memory.set(key, value);
      disk.set(key, value);
    },
  );
  return () => {
    memory.clear();
    for (const [key, value] of disk) memory.set(key, value);
  };
}
export function runtime() {
  let active = true;
  const revoked = new Set<string>();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const controller = new AbortController();
  const close = vi.fn();
  const consent = vi.fn((_request: NativeOAuthDeviceConsentRequest) => ({
    signal: controller.signal,
    close,
  }));
  const fetcher = vi.fn(
    async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = String(target);
      if (url === "https://id.twitch.tv/oauth2/device")
        return Response.json(challenge);
      if (url === "https://id.twitch.tv/oauth2/token")
        return Response.json(token);
      if (url === "https://id.twitch.tv/oauth2/revoke") {
        const form = new URLSearchParams(String(init?.body));
        if (!form.get("token") || form.get("token") === refresh)
          throw new Error("Only the documented access token can be revoked");
        revoked.add(form.get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      if (url === "https://id.twitch.tv/oauth2/validate")
        return revoked.has(
          new Headers(init?.headers)
            .get("authorization")
            ?.replace(/^OAuth /, "") ?? "",
        )
          ? Response.json({ message: "invalid access token" }, { status: 401 })
          : Response.json({
              client_id: clientId,
              user_id: "12345",
              login: "engineer",
              scopes: [],
              expires_in: 14000,
            });
      if (url === "https://api.twitch.tv/helix/users")
        return Response.json({
          data: [{ id: "12345", login: "engineer", display_name: "Engineer" }],
        });
      throw new Error("Unexpected Twitch endpoint");
    },
  );
  const transport = {
    fetch: fetcher,
    settleCredentialMutation: fetcher,
    assertCurrent: () => {
      if (!active) throw new Error("Capability disposed");
    },
  };
  disposers.push(bindNativeProviderTransport(transport));
  disposers.push(
    bindNativeOAuthBrowserPort({
      redirectUri: "https://app.example.org/auth/callback/",
      navigate: () => {},
      scrubCallback: () => {},
      deviceConsent: consent,
    }),
  );
  disposers.push(
    registerNativeProviderCleanup("twitch", nativeBrowserOAuthCleanup),
  );
  const waits: number[] = [];
  const wait = async (delay: number, signal: AbortSignal) => {
    if (signal.aborted) throw new Error("Cancelled");
    waits.push(delay);
    now += delay;
  };
  return {
    fetcher,
    transport,
    controller,
    close,
    consent,
    waits,
    wait,
    dispose: () => {
      active = false;
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
export async function configured() {
  return configureNativeBrowserOAuthConnector({
    providerId: "twitch",
    method: "oauth",
    displayName: "Twitch",
    parameters: { client_id: clientId },
    credentials: {},
    requestedScopes: { user: [] },
    targetIds: {},
  });
}
