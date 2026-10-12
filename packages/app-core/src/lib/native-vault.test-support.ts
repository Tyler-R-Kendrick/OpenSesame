import { vi } from "vitest";
import * as kv from "./kv.js";
import { registerNativeProviderCleanup } from "./native-connector-lifecycle.js";
import { bindNativeProviderTransport } from "./native-connector-transport.js";
import { nativeVaultCleanup } from "./native-vault-cleanup.js";
export const redirectUri = "https://app.example.org/OpenSesame/auth/callback/";
export const state = "provider-generated-state-01234567890123456789";
export const nonce = "provider-generated-nonce";
export const token = "hvs.actual-oidc-issued-test-token";
export const input = {
  providerId: "vault" as const,
  endpoint: "https://vault.example.org",
  namespace: "engineering",
  authMount: "oidc",
  role: "browser-read",
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
export function authorizationUrl() {
  const url = new URL("https://identity.example.org/authorize");
  url.search = new URLSearchParams({
    client_id: "vault-server-client",
    response_type: "code",
    redirect_uri: redirectUri,
    nonce,
    state,
  }).toString();
  return url.href;
}
export function provider(providerId: "vault" | "openbao" = "vault") {
  let active = true;
  const fetcher = vi.fn(
    async (target: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(target));
      if (url.pathname.endsWith("/oidc/auth_url"))
        return Response.json({ data: { auth_url: authorizationUrl() } });
      if (url.pathname.endsWith("/oidc/callback"))
        return Response.json({
          auth: { client_token: token, lease_duration: 300 },
        });
      if (url.pathname.endsWith("/lookup-self"))
        return Response.json({
          data: {
            entity_id: "entity-from-idp",
            display_name: "oidc-engineer",
            policies: ["browser-read"],
            ttl: 300,
            renewable: true,
          },
        });
      if (url.pathname.endsWith("/revoke-self"))
        return new Response(null, { status: 204 });
      if (url.pathname === "/v1/secret/data/app/config")
        return Response.json({
          data: {
            data: { setting: "real-KV-shaped-value" },
            metadata: { version: 2 },
          },
        });
      throw new Error("Unexpected provider path");
    },
  );
  const transport = {
    fetch: fetcher,
    settleCredentialMutation: fetcher,
    assertCurrent: () => {
      if (!active) throw new Error("Provider runtime disposed");
    },
  };
  disposers.push(bindNativeProviderTransport(transport));
  disposers.push(
    registerNativeProviderCleanup(
      providerId,
      nativeVaultCleanup(providerId, transport),
    ),
  );
  return {
    fetcher,
    transport,
    dispose: () => {
      active = false;
    },
  };
}
