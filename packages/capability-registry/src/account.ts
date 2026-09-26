import { AUTH_CEREMONY } from "./exclusions.js";
/**
 * The signed-in account (ADR 0091) and its own factors (ADR 0140 D10).
 *
 * Signing in, out and across accounts are authentication ceremonies; so is
 * adding or removing a passkey or an authenticator app on the Identity
 * account, and so is reading which ones it has — the list is the map of
 * what a second step on that account would need. None of it is agent work:
 * every entry is withheld from every agent surface (ADR 0023). The factors
 * are Settings › Security rows in Pages, beside the vault's own keys, owned
 * by `identity.federation`.
 */
import type { Capability } from "./index.js";

export const accountCapabilities: readonly Capability[] = [
  {
    id: "identity.login",
    title: "Identity sign-in (device, loopback, anonymous)",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id login",
      pwa: "lib/federation.ts:beginSignIn",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: AUTH_CEREMONY,
      mcp_client: AUTH_CEREMONY,
      webmcp: AUTH_CEREMONY,
    },
  },
  {
    id: "identity.signout",
    title:
      "Sign out of this device: end the Identity session, forget the upstream assertion, lock the vault",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame logout",
      pwa: "lib/session-exit.ts:signOut",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: AUTH_CEREMONY,
      mcp_client: AUTH_CEREMONY,
      webmcp: AUTH_CEREMONY,
    },
  },
  {
    id: "identity.switch_account",
    title:
      "Switch account: sign out, then sign in afresh as somebody else (prompt=login on OIDC issuers)",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/session-exit.ts:switchAccount",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: AUTH_CEREMONY,
      mcp_client: AUTH_CEREMONY,
      webmcp: AUTH_CEREMONY,
    },
  },
  {
    id: "identity.account_factors.list",
    title:
      "List the signed-in account's own passkeys and authenticator app (GET /v1/mfa/factors; never a key, seed or counter)",
    plane: "identity",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "lib/account-factors.ts:listAccountFactors",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: AUTH_CEREMONY,
      mcp_client: AUTH_CEREMONY,
      webmcp: AUTH_CEREMONY,
    },
  },
  {
    id: "identity.account_factors.enroll",
    title:
      "Add a passkey or an authenticator app to the signed-in account (POST /v1/mfa/passkey/*, /v1/mfa/totp/*)",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/account-factors.ts:enrollAccountPasskey",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: AUTH_CEREMONY,
      mcp_client: AUTH_CEREMONY,
      webmcp: AUTH_CEREMONY,
    },
  },
  {
    id: "identity.account_factors.remove",
    title:
      "Remove one of the signed-in account's own factors, proved by a fresh step-up from one of them (DELETE /v1/mfa/factors/:id; ADR 0146)",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/account-factors.ts:removeAccountFactor",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: AUTH_CEREMONY,
      mcp_client: AUTH_CEREMONY,
      webmcp: AUTH_CEREMONY,
    },
  },
];
