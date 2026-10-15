/** Native identity APIs return assertions which share the federation admission path. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";
import { z } from "zod";
import type { UpstreamIdentity } from "./federation.js";
import { parseIdentityPublicJwks } from "./identity-connections-jwks.js";
import {
  type IdentityConnectionCredentials,
  type IdentityConnectionDraft,
  type IdentityConnectionTest,
  identityEndpoint,
} from "./identity-connections-schema.js";
import { localNetworkFetch } from "./local-network-fetch.js";

/** The network supplied no authentication answer; callers may retain remembered identity. */
export class IdentitySessionUnavailableError extends Error {
  constructor() {
    super("Unable to contact the configured identity provider.");
    this.name = "IdentitySessionUnavailableError";
  }
}

const UserSchema = z.object({
  id: z.string().min(1),
  email: z.string().optional(),
  name: z.string().optional(),
});
const SessionSchema = z.object({
  user: UserSchema,
  session: z.object({ expiresAt: z.string() }),
});
const TokenSchema = z.object({ token: z.string().min(1) });
const SupabaseTokenSchema = z.object({ access_token: z.string().min(1) });
const ClaimsSchema = z.object({
  iss: z.string().min(1),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number().int(),
  nbf: z.number().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
});
type NativeIdentityClaims = z.infer<typeof ClaimsSchema>;

type NativeIdentityHeaders = {
  apikey?: string;
  Authorization?: string;
  "Content-Type"?: string;
};

function authBase(draft: IdentityConnectionDraft): string {
  const base = identityEndpoint(draft.baseUrl);
  if (!base)
    throw new Error(
      "Enter an HTTPS identity API URL or a local HTTP development URL.",
    );
  if (draft.protocol === "supabase") {
    return base.endsWith("/auth/v1") ? base : `${base}/auth/v1`;
  }
  // The supplied path is the operator's actual Better Auth mount point.
  return new URL(base).pathname === "/" ? `${base}/api/auth` : base;
}

export function identitySessionIssuer(draft: IdentityConnectionDraft): string {
  if (draft.issuer) return draft.issuer;
  if (draft.protocol === "supabase") return authBase(draft);
  // Better Auth's standard baseURL is the origin; custom JWT issuers are explicit.
  return new URL(authBase(draft)).origin;
}

export function identitySessionAudience(
  draft: IdentityConnectionDraft,
): string {
  return (
    draft.audience ||
    draft.clientId ||
    (draft.protocol === "supabase"
      ? "authenticated"
      : identitySessionIssuer(draft))
  );
}

export function identitySessionJwksUri(draft: IdentityConnectionDraft): string {
  if (draft.jwksUri) {
    const uri = identityEndpoint(draft.jwksUri);
    if (!uri)
      throw new Error(
        "Enter an HTTPS signing keys URL or a local HTTP development URL.",
      );
    return uri;
  }
  const path =
    draft.protocol === "supabase" || draft.providerId === "neon-auth"
      ? ".well-known/jwks.json"
      : "jwks";
  return `${authBase(draft)}/${path}`;
}

function publicHeaders(draft: IdentityConnectionDraft): NativeIdentityHeaders {
  if (draft.protocol !== "supabase") return {};
  const key = draft.publicKey.trim();
  if (key.startsWith("sb_secret_"))
    throw new Error("Use a Supabase publishable key, never a secret key.");
  if (!key.startsWith("sb_publishable_")) {
    try {
      if (decodeJwt(key).role !== "anon") throw new Error("invalid key");
    } catch {
      throw new Error("Use a Supabase publishable key or a legacy anon key.");
    }
  }
  return { apikey: key };
}

async function requestJson(
  url: string,
  init: RequestInit = {},
): Promise<BoundaryValue> {
  let response: Response;
  try {
    response = await localNetworkFetch(url, {
      ...init,
      redirect: "error",
      cache: "no-store",
      timeoutMs: 15_000,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "SecurityError")
      throw error;
    throw new IdentitySessionUnavailableError();
  }
  if (!response.ok) {
    // Provider bodies may echo credentials or tokens. Never surface them.
    throw new Error(
      `Identity request failed (${response.status}). Check the connection and sign-in details.`,
    );
  }
  const value: BoundaryValue = await response.json();
  return value;
}

async function jwks(draft: IdentityConnectionDraft) {
  return parseIdentityPublicJwks(
    await requestJson(identitySessionJwksUri(draft), {
      credentials: "omit",
      headers: publicHeaders(draft),
    }),
  );
}

async function verifiedClaims(
  draft: IdentityConnectionDraft,
  token: string,
  serverVerified: boolean,
) {
  const header = decodeProtectedHeader(token);
  let claims: NativeIdentityClaims;
  if (serverVerified && header.alg === "HS256") {
    // Supabase legacy symmetric projects verify the token at GET /user;
    // the secret never belongs in this public client.
    claims = ClaimsSchema.parse(decodeJwt(token));
  } else {
    const verified = await jwtVerify(
      token,
      createLocalJWKSet(await jwks(draft)),
      {
        issuer: identitySessionIssuer(draft),
        audience: identitySessionAudience(draft),
        algorithms: ["EdDSA", "RS256", "ES256", "PS256"],
        requiredClaims: ["sub", "exp", "iss", "aud"],
      },
    );
    claims = ClaimsSchema.parse(verified.payload);
  }
  const audience = identitySessionAudience(draft);
  if (
    claims.iss !== identitySessionIssuer(draft) ||
    !(Array.isArray(claims.aud)
      ? claims.aud.includes(audience)
      : claims.aud === audience)
  ) {
    throw new Error(
      "The identity token does not match the configured issuer and audience.",
    );
  }
  if (
    claims.exp * 1000 <= Date.now() ||
    (claims.nbf !== undefined && claims.nbf * 1000 > Date.now())
  ) {
    throw new Error("The identity session is expired or is not yet valid.");
  }
  return claims;
}

/** Returns a verified assertion; the caller saves and adopts it using federation. */
export async function signInIdentitySession(
  draft: IdentityConnectionDraft,
  credentials: IdentityConnectionCredentials,
): Promise<UpstreamIdentity> {
  if (draft.protocol !== "better-auth" && draft.protocol !== "supabase") {
    throw new Error("This connection does not use a native identity session.");
  }
  if (!credentials.email.trim() || !credentials.password) {
    throw new Error("Enter your email and password to sign in.");
  }
  const base = authBase(draft);
  const headers = {
    "Content-Type": "application/json",
    ...publicHeaders(draft),
  };
  const body = JSON.stringify({
    email: credentials.email.trim(),
    password: credentials.password,
  });
  let token: string;
  let live: Awaited<ReturnType<typeof liveIdentitySession>> | undefined;
  if (draft.protocol === "supabase") {
    const response = SupabaseTokenSchema.parse(
      await requestJson(`${base}/token?grant_type=password`, {
        method: "POST",
        headers,
        body,
        credentials: "omit",
      }),
    );
    token = response.access_token;
  } else {
    await requestJson(`${base}/sign-in/email`, {
      method: "POST",
      headers,
      body,
      credentials: "include",
    });
    live = await liveIdentitySession(draft, "");
    token = TokenSchema.parse(
      await requestJson(`${base}/token`, { credentials: "include" }),
    ).token;
  }
  return live
    ? identityFromLiveSession(draft, token, live)
    : verifyIdentitySessionAssertion(draft, token);
}

async function liveIdentitySession(
  draft: IdentityConnectionDraft,
  token: string,
) {
  const base = authBase(draft);
  if (draft.protocol === "supabase") {
    return {
      user: UserSchema.parse(
        await requestJson(`${base}/user`, {
          headers: {
            ...publicHeaders(draft),
            Authorization: `Bearer ${token}`,
          },
          credentials: "omit",
        }),
      ),
      sessionExpiry: undefined,
    };
  }
  if (draft.protocol !== "better-auth")
    throw new Error("This connection does not use a native identity session.");
  const session = SessionSchema.parse(
    await requestJson(`${base}/get-session?disableCookieCache=true`, {
      credentials: "include",
    }),
  );
  const sessionExpiry = Date.parse(session.session.expiresAt);
  if (!Number.isFinite(sessionExpiry) || sessionExpiry <= Date.now()) {
    throw new Error("The identity provider returned an expired session.");
  }
  return { user: session.user, sessionExpiry };
}

/** Reload verifies the current provider session as well as the saved assertion. */
export async function verifyIdentitySessionAssertion(
  draft: IdentityConnectionDraft,
  token: string,
): Promise<UpstreamIdentity> {
  return identityFromLiveSession(
    draft,
    token,
    await liveIdentitySession(draft, token),
  );
}

async function identityFromLiveSession(
  draft: IdentityConnectionDraft,
  token: string,
  { user, sessionExpiry }: Awaited<ReturnType<typeof liveIdentitySession>>,
): Promise<UpstreamIdentity> {
  const claims = await verifiedClaims(
    draft,
    token,
    draft.protocol === "supabase",
  );
  if (claims.sub !== user.id)
    throw new Error(
      "The verified identity token does not match the signed-in user.",
    );
  return {
    issuer: claims.iss,
    upstreamId: draft.providerId,
    idToken: token,
    pairwiseSub: claims.sub,
    audience: identitySessionAudience(draft),
    jwksUri: identitySessionJwksUri(draft),
    expiresAt: Math.min(
      claims.exp * 1000,
      sessionExpiry ?? Number.POSITIVE_INFINITY,
    ),
    email: claims.email ?? user.email,
    name: claims.name ?? user.name,
    picture: claims.picture,
  };
}

/** Read-only protocol probe; reachability is deliberately separate from signing in. */
export async function testIdentitySession(
  draft: IdentityConnectionDraft,
): Promise<IdentityConnectionTest> {
  if (draft.protocol === "supabase") {
    await requestJson(`${authBase(draft)}/settings`, {
      credentials: "omit",
      headers: publicHeaders(draft),
    });
    return {
      message:
        "Supabase Auth settings are reachable. Sign in to verify your account.",
    };
  }
  const keys = await jwks(draft);
  if (!keys.keys.some((key) => ["RSA", "EC", "OKP"].includes(key.kty))) {
    throw new Error(
      "Enable the Better Auth JWT plugin with asymmetric signing keys and allow this app's origin.",
    );
  }
  return {
    message:
      "The identity API publishes signing keys. Sign in to verify a session.",
  };
}

/** Revoke the provider session before the local connection is disconnected. */
export async function logoutIdentitySession(
  draft: IdentityConnectionDraft,
  token?: string,
): Promise<void> {
  const supabase = draft.protocol === "supabase";
  if (supabase && !token) return;
  const headers: NativeIdentityHeaders = {
    "Content-Type": "application/json",
    ...publicHeaders(draft),
  };
  if (supabase) headers.Authorization = `Bearer ${token}`;
  const response = await localNetworkFetch(
    `${authBase(draft)}/${supabase ? "logout?scope=local" : "sign-out"}`,
    {
      method: "POST",
      credentials: supabase ? "omit" : "include",
      redirect: "error",
      cache: "no-store",
      headers,
      body: "{}",
    },
  );
  if (!response.ok && response.status !== 401) {
    throw new Error(`Identity sign-out failed (${response.status}).`);
  }
}
