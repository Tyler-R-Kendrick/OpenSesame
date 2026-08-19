import { createPkcePair } from "./pkce.js";
import type {
  ClaimDecision,
  ClaimPresentation,
  OidcDiscoveryDocument,
  OpenSesameBrowserClient,
  OpenSesameBrowserConfig,
  ProvisionalSessionResponse,
  Session,
  StorageLike,
  TokenResponse,
} from "./types.js";

const PKCE_KEY = "opensesame:pkce";
const SESSION_KEY = "opensesame:session";

class MemoryStorage implements StorageLike {
  readonly #map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
}

/**
 * Default away from localStorage: tokens/PKCE must not survive as durable
 * XSS-exfiltrable material across browser restarts. sessionStorage still
 * survives the OAuth redirect in the same tab; memory is last resort.
 */
function resolveStorage(storage?: StorageLike): StorageLike {
  if (storage) return storage;
  if (typeof globalThis !== "undefined" && "sessionStorage" in globalThis) {
    try {
      const ss = globalThis.sessionStorage;
      // Touch to ensure the Storage is usable (private mode quirks).
      ss.getItem("opensesame:probe");
      return ss;
    } catch {
      /* fall through */
    }
  }
  return new MemoryStorage();
}

/** Persist session without refresh tokens (keep those in-process only). */
function sessionForStorage(session: Session): Session {
  const { refreshToken: _drop, ...rest } = session;
  if (rest.raw && typeof rest.raw === "object") {
    const { refresh_token: _omit, ...raw } = rest.raw as TokenResponse &
      Record<string, unknown>;
    return { ...rest, raw: raw as TokenResponse };
  }
  return rest;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/u.test(host);
}

/**
 * Every URL this client sends a code, a verifier, or a token to must be one an
 * onlooker cannot rewrite. http is tolerated only on loopback, where the
 * development server lives.
 */
export function assertSecureUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} must be an absolute URL`);
  }
  if (url.protocol === "https:") return raw;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return raw;
  throw new Error(`${what} must use https (http is allowed only on loopback)`);
}

/** Hosts that only mean something inside the user's own network. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isLoopbackHost(host)) return true;
  if (host === "0.0.0.0" || host === "::") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (/^f[cd][0-9a-f]{2}:/u.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/u.test(host)) return true;
  return host.endsWith(".internal") || host.endsWith(".local");
}

/**
 * An endpoint the issuer named, rather than one the application configured.
 *
 * Cleartext on loopback is the right affordance for a value the app wrote and the
 * wrong one for a value a remote issuer supplies: it lets that issuer aim the
 * ceremony — the authorization redirect, or the POST carrying the code and
 * verifier — at something listening on the user's own machine. A discovered
 * endpoint may only name private space when the issuer is itself private.
 */
export function assertDiscoveredUrl(
  raw: string,
  what: string,
  issuer: string,
): string {
  const checked = assertSecureUrl(raw, what);
  let issuerHost: string;
  try {
    issuerHost = new URL(issuer).hostname;
  } catch {
    throw new Error("issuer must be an absolute URL");
  }
  if (isPrivateHost(issuerHost)) return checked;
  if (isPrivateHost(new URL(checked).hostname)) {
    throw new Error(
      `${what} names a private or loopback host, but the issuer is remote`,
    );
  }
  return checked;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(
      atob(part.replace(/-/g, "+").replace(/_/g, "/")),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * What the client is required to check about an id_token it asked for.
 *
 * The browser cannot verify the signature, so the access token — not this — is
 * the authority. But an id_token whose audience, issuer, or nonce is not the one
 * this ceremony asked for is somebody else's token, and caching a `sub` from it
 * would hand the application the wrong identity.
 */
function assertIdTokenAddressedToUs(
  idToken: string,
  expect: { issuer: string; clientId: string; nonce?: string },
): Record<string, unknown> | undefined {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return undefined;
  const iss =
    typeof payload.iss === "string" ? trimSlash(payload.iss) : undefined;
  if (iss !== undefined && iss !== expect.issuer) {
    throw new Error("id_token issued by a different issuer");
  }
  const aud = payload.aud;
  const audiences = Array.isArray(aud)
    ? aud.map(String)
    : typeof aud === "string"
      ? [aud]
      : [];
  if (audiences.length > 0 && !audiences.includes(expect.clientId)) {
    throw new Error("id_token addressed to a different client");
  }
  if (expect.nonce !== undefined && payload.nonce !== expect.nonce) {
    throw new Error("id_token nonce mismatch");
  }
  return payload;
}

function toSession(
  tokens: TokenResponse,
  anonymous: boolean,
  expect: { issuer: string; clientId: string; nonce?: string },
): Session {
  const expiresAt =
    typeof tokens.expires_in === "number"
      ? Date.now() + tokens.expires_in * 1000
      : undefined;
  let sub: string | undefined;
  if (tokens.id_token) {
    const payload = assertIdTokenAddressedToUs(tokens.id_token, expect);
    sub = typeof payload?.sub === "string" ? payload.sub : undefined;
  }
  const session: Session = {
    accessToken: tokens.access_token,
    anonymous,
    raw: tokens,
  };
  if (tokens.id_token !== undefined) session.idToken = tokens.id_token;
  if (tokens.refresh_token !== undefined)
    session.refreshToken = tokens.refresh_token;
  if (expiresAt !== undefined) session.expiresAt = expiresAt;
  if (sub !== undefined) session.sub = sub;
  return session;
}

export function createOpenSesame(
  config: OpenSesameBrowserConfig,
): OpenSesameBrowserClient {
  const issuer = trimSlash(config.issuer);
  assertSecureUrl(issuer, "issuer");
  const clientId = config.clientId ?? "opensesame-browser";
  const redirectUri =
    config.redirectUri ??
    (typeof globalThis !== "undefined" && "location" in globalThis
      ? `${globalThis.location.origin}/callback`
      : "http://127.0.0.1/callback");
  const scopes = (config.scopes ?? ["openid", "profile"]).join(" ");
  const storage = resolveStorage(config.storage);
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiBase = assertSecureUrl(
    trimSlash(config.apiBase ?? issuer),
    "apiBase",
  );
  let discoveryCache: OidcDiscoveryDocument | undefined;

  async function discovery(): Promise<OidcDiscoveryDocument> {
    if (discoveryCache) return discoveryCache;
    const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
    if (!res.ok) {
      throw new Error(`OIDC discovery failed: ${res.status}`);
    }
    const meta = (await res.json()) as OidcDiscoveryDocument;
    // The discovery document decides where the code and the verifier are sent.
    // An issuer that does not name itself, or an endpoint reachable over
    // cleartext, is a document that hands the ceremony to whoever answered.
    if (trimSlash(meta.issuer ?? "") !== issuer) {
      throw new Error(
        "OIDC discovery issuer does not match the configured issuer",
      );
    }
    assertDiscoveredUrl(
      meta.authorization_endpoint,
      "authorization_endpoint",
      issuer,
    );
    assertDiscoveredUrl(meta.token_endpoint, "token_endpoint", issuer);
    if (meta.end_session_endpoint) {
      assertDiscoveredUrl(
        meta.end_session_endpoint,
        "end_session_endpoint",
        issuer,
      );
    }
    discoveryCache = meta;
    return discoveryCache;
  }

  /** In-tab refresh token; never written to StorageLike. */
  let refreshTokenMemory: string | undefined;

  function saveSession(session: Session): void {
    if (session.refreshToken) {
      refreshTokenMemory = session.refreshToken;
    }
    storage.setItem(SESSION_KEY, JSON.stringify(sessionForStorage(session)));
  }

  function readSession(): Session | null {
    const raw = storage.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
      const session = JSON.parse(raw) as Session;
      if (!session.refreshToken && refreshTokenMemory) {
        session.refreshToken = refreshTokenMemory;
      }
      return session;
    } catch {
      storage.removeItem(SESSION_KEY);
      return null;
    }
  }

  async function exchangeCode(
    code: string,
    codeVerifier: string,
    nonce: string | undefined,
  ): Promise<Session> {
    const meta = await discovery();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });
    const res = await fetchImpl(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Token exchange failed: ${res.status}`);
    }
    const tokens = (await res.json()) as TokenResponse;
    const session = toSession(tokens, false, {
      issuer,
      clientId,
      ...(nonce ? { nonce } : {}),
    });
    saveSession(session);
    return session;
  }

  return {
    async signIn(options) {
      const meta = await discovery();
      const pkce = await createPkcePair();
      storage.setItem(PKCE_KEY, JSON.stringify(pkce));
      const url = new URL(meta.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", scopes);
      url.searchParams.set("state", pkce.state);
      url.searchParams.set("nonce", pkce.nonce);
      url.searchParams.set("code_challenge", pkce.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      if (options?.provider) {
        url.searchParams.set("kc_idp_hint", options.provider);
        url.searchParams.set("login_hint_provider", options.provider);
      }
      const loc =
        config.windowLocation ??
        (typeof globalThis !== "undefined" && "location" in globalThis
          ? globalThis.location
          : undefined);
      if (!loc) {
        throw new Error("No window.location available for signIn redirect");
      }
      loc.assign(url.toString());
    },

    async handleRedirectCallback(callbackUrl) {
      const href =
        callbackUrl ??
        config.windowLocation?.href ??
        (typeof globalThis !== "undefined" && "location" in globalThis
          ? globalThis.location.href
          : "");
      const url = new URL(href);
      const error = url.searchParams.get("error");
      if (error) {
        storage.removeItem(PKCE_KEY);
        throw new Error(`Authorization error: ${error}`);
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const rawPkce = storage.getItem(PKCE_KEY);
      if (!code || !state || !rawPkce) {
        throw new Error("Missing authorization code or PKCE state");
      }
      let pkce: { state: string; codeVerifier: string; nonce?: string };
      try {
        pkce = JSON.parse(rawPkce) as {
          state: string;
          codeVerifier: string;
          nonce?: string;
        };
      } catch {
        storage.removeItem(PKCE_KEY);
        throw new Error("Stored PKCE state is unreadable");
      }
      // One verifier, one callback. A verifier left in storage after a failed or
      // refused callback is one a second attempt can still spend.
      storage.removeItem(PKCE_KEY);
      if (pkce.state !== state) {
        throw new Error("OAuth state mismatch");
      }
      return exchangeCode(code, pkce.codeVerifier, pkce.nonce);
    },

    async continueAnonymously() {
      const res = await fetchImpl(`${apiBase}/v1/principals/provisional`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ clientId }),
      });
      if (!res.ok) {
        throw new Error(`Anonymous session failed: ${res.status}`);
      }
      const body = (await res.json()) as ProvisionalSessionResponse;
      if (typeof body.accessToken !== "string" || body.accessToken === "") {
        throw new Error("Anonymous session response carried no access token");
      }
      const expiresAt =
        typeof body.expiresAt === "string"
          ? Date.parse(body.expiresAt)
          : undefined;
      const session: Session = {
        accessToken: body.accessToken,
        anonymous: true,
        raw: {
          access_token: body.accessToken,
          token_type: body.tokenType ?? "Bearer",
          ...(expiresAt !== undefined && !Number.isNaN(expiresAt)
            ? {
                expires_in: Math.max(
                  0,
                  Math.floor((expiresAt - Date.now()) / 1000),
                ),
              }
            : {}),
        },
      };
      if (expiresAt !== undefined && !Number.isNaN(expiresAt)) {
        session.expiresAt = expiresAt;
      }
      if (typeof body.principalId === "string") {
        session.sub = body.principalId;
      }
      saveSession(session);
      return session;
    },

    async getSession() {
      const session = readSession();
      if (!session) return null;
      if (session.expiresAt && session.expiresAt <= Date.now()) {
        storage.removeItem(SESSION_KEY);
        return null;
      }
      return session;
    },

    async presentClaim(token) {
      const session = readSession();
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
      };
      if (session?.accessToken) {
        headers.authorization = `Bearer ${session.accessToken}`;
      }
      const res = await fetchImpl(`${apiBase}/v1/claims/present`, {
        method: "POST",
        headers,
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        throw new Error(`presentClaim failed: ${res.status}`);
      }
      return (await res.json()) as ClaimPresentation;
    },

    async readClaim(claimId, claimToken) {
      const res = await fetchImpl(
        `${apiBase}/v1/claims/${encodeURIComponent(claimId)}`,
        {
          headers: {
            accept: "application/json",
            "x-claim-token": claimToken,
          },
        },
      );
      if (!res.ok) {
        throw new Error(`readClaim failed: ${res.status}`);
      }
      return (await res.json()) as ClaimPresentation;
    },

    async completeClaim(claimId, decision: ClaimDecision) {
      const session = readSession();
      if (!session) {
        throw new Error("Authentication required to complete claim");
      }
      const encodedId = encodeURIComponent(claimId);
      const body: Record<string, unknown> = {
        acceptedItemIds: decision.acceptedItemIds,
      };
      body.userCode = decision.userCode;
      if (decision.destination !== undefined)
        body.destination = decision.destination;
      if (decision.idempotencyKey !== undefined) {
        body.idempotencyKey = decision.idempotencyKey;
      }
      if (decision.claimToken !== undefined) {
        body.claimToken = decision.claimToken;
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${session.accessToken}`,
      };
      if (decision.claimToken) {
        headers["x-claim-token"] = decision.claimToken;
      }
      const res = await fetchImpl(
        `${apiBase}/v1/claims/${encodedId}/complete`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        throw new Error(`completeClaim failed: ${res.status}`);
      }
      return (await res.json()) as ClaimPresentation;
    },

    async linkIdentity(options) {
      await this.signIn({ provider: options.provider });
    },

    async signOut() {
      const session = readSession();
      refreshTokenMemory = undefined;
      storage.removeItem(SESSION_KEY);
      storage.removeItem(PKCE_KEY);
      // A provisional session authenticates by its token alone, so clearing
      // client storage is not enough — end it server-side too.
      if (session?.anonymous && session.accessToken) {
        try {
          await fetchImpl(`${apiBase}/v1/principals/provisional/revoke`, {
            method: "POST",
            headers: { authorization: `Bearer ${session.accessToken}` },
          });
        } catch {
          // local sign-out still succeeds if the control plane is unreachable
        }
      }
      try {
        const meta = await discovery();
        if (meta.end_session_endpoint) {
          const loc =
            config.windowLocation ??
            (typeof globalThis !== "undefined" && "location" in globalThis
              ? globalThis.location
              : undefined);
          loc?.assign(meta.end_session_endpoint);
        }
      } catch {
        // local sign-out still succeeds if discovery is unreachable
      }
    },
  };
}

export type { OpenSesameBrowserClient, OpenSesameBrowserConfig, Session };
