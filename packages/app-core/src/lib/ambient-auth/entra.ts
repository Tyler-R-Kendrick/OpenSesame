import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";

/**
 * Entra / MSAL Browser v5 adapter. Lazy-loaded only for a selected Entra
 * connection. A cached SDK account is a routing preference, not proof.
 */

import { verifyBrowserIdTokenClaims } from "@opensesame/sdk-browser";
import type { VerifiedIdTokenClaims } from "@opensesame/sdk-browser";
import { randomString } from "@opensesame/sdk-browser";
import type { UpstreamIdentity } from "../federation.js";
import { rememberEntraInstance } from "./entra-instances.js";
import { matchesAuthGeneration } from "./generation.js";
import type { ProviderConnection } from "./provider.js";
import type { AmbientReasonCode, PassiveOutcome } from "./types.js";

export const ENTRA_SCOPES = ["openid"] as const;
export const MSAL_BROWSER_VERSION = "5.22.0";

export type EntraSilentRequest = {
  connection: ProviderConnection;
  redirectUri: string;
  loginHint?: string;
  generation: number;
  nonce: string;
};

export type EntraSdkAccount = {
  homeAccountId: string;
  username?: string;
  tenantId?: string;
  localAccountId?: string;
};

export type EntraIdTokenResult = {
  idToken: string;
  tenantId?: string;
};

export type EntraSdk = {
  getAllAccounts(): EntraSdkAccount[];
  ssoSilent(request: {
    scopes: string[];
    loginHint?: string;
    nonce?: string;
    prompt?: string;
    redirectUri?: string;
    authority?: string;
  }): Promise<EntraIdTokenResult>;
  clearCache(): Promise<void>;
};

export type EntraSdkLoader = (input: {
  clientId: string;
  authority: string;
  redirectUri: string;
}) => Promise<EntraSdk>;

async function loadMsalSdk(input: {
  clientId: string;
  authority: string;
  redirectUri: string;
}): Promise<EntraSdk> {
  const msal = await import("@azure/msal-browser");
  const pca = new msal.PublicClientApplication({
    auth: {
      clientId: input.clientId,
      authority: input.authority,
      redirectUri: input.redirectUri,
    },
    // Tokens and account records stay in memory (ADR 0149): MSAL writes its
    // cache straight to Web Storage, past the at-rest seal, and a cached
    // account is only a routing hint here — every sign-in verifies a fresh
    // ID token. MSAL still keeps the request in flight (state, PKCE
    // verifier) in sessionStorage for a redirect or popup sign-in, and marks
    // SSO capability in localStorage after one; this adapter offers neither,
    // only silent SSO, so MSAL writes nothing to Web Storage at all.
    cache: {
      cacheLocation: "memoryStorage",
    },
    system: {
      allowRedirectInIframe: false,
    },
  });
  await pca.initialize();
  // Resetting this browser clears what this instance cached, account
  // records included (`entra-instances.ts`).
  rememberEntraInstance(input.clientId, () => pca.clearCache());
  return {
    getAllAccounts: () => pca.getAllAccounts(),
    ssoSilent: async (request) => {
      const result = await pca.ssoSilent({
        scopes: [...request.scopes],
        loginHint: request.loginHint,
        nonce: request.nonce,
        prompt: request.prompt,
        redirectUri: request.redirectUri,
        authority: request.authority,
      });
      if (!result.idToken) throw new Error("msal_missing_id_token");
      return { idToken: result.idToken, tenantId: result.tenantId };
    },
    clearCache: async () => {
      await pca.clearCache();
    },
  };
}

export const entraSeams = {
  loadSdk: loadMsalSdk,
} satisfies { loadSdk: EntraSdkLoader };

export function entraRedirectBridgePath(base: string): string {
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}auth/redirect.html`;
}

export function entraAuthority(connection: ProviderConnection): string {
  if (connection.tenantAuthority) return connection.tenantAuthority;
  return connection.issuer;
}

function mapMsalError(err: BoundaryValue): AmbientReasonCode {
  const message = err instanceof Error ? err.message : String(err);
  const code = message.toLowerCase();
  if (
    code.includes("interaction_required") ||
    code.includes("interaction required")
  ) {
    return "interaction_required";
  }
  if (code.includes("login_required") || code.includes("login required")) {
    return "login_required";
  }
  if (code.includes("consent")) return "consent_required";
  if (code.includes("timeout")) return "timeout";
  return "unavailable";
}

export async function acquireEntraSilent(
  request: EntraSilentRequest,
  fetchImpl: typeof fetch,
): Promise<
  | {
      kind: "authenticated";
      identity: UpstreamIdentity;
      claims: VerifiedIdTokenClaims;
    }
  | Extract<
      PassiveOutcome,
      {
        kind:
          | "interaction-required"
          | "unsupported"
          | "unavailable"
          | "rejected";
      }
    >
> {
  if (request.connection.protocol !== "entra") {
    return { kind: "unsupported", reason: "unsupported" };
  }
  if (!matchesAuthGeneration(request.generation)) {
    return { kind: "rejected", reason: "stale_generation" };
  }
  const sdk = await entraSeams.loadSdk({
    clientId: request.connection.clientId,
    authority: entraAuthority(request.connection),
    redirectUri: request.redirectUri,
  });
  // MSAL's cache lives in memory (ADR 0149), so this sees only the accounts
  // this document signed in; across loads, Entra itself answers a hintless
  // silent request over several sessions with interaction_required, which
  // maps to the same outcome below.
  const accounts = sdk.getAllAccounts();
  if (accounts.length > 1 && !request.loginHint) {
    return { kind: "interaction-required", reason: "interaction_required" };
  }
  let result: EntraIdTokenResult;
  try {
    result = await sdk.ssoSilent({
      scopes: [...ENTRA_SCOPES],
      loginHint: request.loginHint,
      nonce: request.nonce,
      prompt: "none",
      redirectUri: request.redirectUri,
      authority: entraAuthority(request.connection),
    });
  } catch (err) {
    return {
      kind: "interaction-required",
      reason: mapMsalError(overlapCast(err)),
    };
  }
  if (!matchesAuthGeneration(request.generation)) {
    return { kind: "rejected", reason: "stale_generation" };
  }
  const jwksUri = entraJwksUri(request.connection.issuer);
  const claims = await verifyBrowserIdTokenClaims({
    token: result.idToken,
    nonce: request.nonce,
    issuer: request.connection.issuer,
    clientId: request.connection.clientId,
    jwksUri,
    fetchImpl,
  });
  const identity: UpstreamIdentity = {
    issuer: claims.iss,
    upstreamId: request.connection.key,
    idToken: result.idToken,
    pairwiseSub: claims.sub,
    audience: request.connection.clientId,
    jwksUri,
    expiresAt: claims.exp * 1000,
    ...(claims.email ? { email: claims.email } : undefined),
    ...(claims.name ? { name: claims.name } : undefined),
  };
  return { kind: "authenticated", identity, claims };
}

export function newEntraNonce(): string {
  return randomString(32);
}

/** Entra JWKS is `{tenant}/discovery/v2.0/keys`, not `{issuer}/discovery/v2.0/keys`. */
export function entraJwksUri(issuer: string): string {
  const trimmed = issuer.replace(/\/+$/, "");
  const tenant = trimmed.replace(/\/v2\.0$/, "");
  return `${tenant}/discovery/v2.0/keys`;
}

export async function clearEntraAdapter(
  connection: ProviderConnection,
  redirectUri: string,
): Promise<void> {
  try {
    const sdk = await entraSeams.loadSdk({
      clientId: connection.clientId,
      authority: entraAuthority(connection),
      redirectUri,
    });
    await sdk.clearCache();
  } catch {
    /* adapter may not have been loaded */
  }
}
