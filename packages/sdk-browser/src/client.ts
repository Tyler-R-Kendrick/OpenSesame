import { ClaimRequestError } from "./errors.js";
import { createPkcePair } from "./pkce.js";
import type {
  ClaimDecision,
  ClaimPresentation,
  OidcDiscoveryDocument,
  OpenSesameBrowserClient,
  OpenSesameBrowserConfig,
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

function toSession(tokens: TokenResponse, anonymous: boolean): Session {
  const expiresAt =
    typeof tokens.expires_in === "number"
      ? Date.now() + tokens.expires_in * 1000
      : undefined;
  let sub: string | undefined;
  if (tokens.id_token) {
    try {
      const payload = tokens.id_token.split(".")[1];
      if (payload) {
        const json = JSON.parse(
          atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
        ) as { sub?: string };
        sub = json.sub;
      }
    } catch {
      // ignore malformed id_token for session cache
    }
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
  const clientId = config.clientId ?? "opensesame-browser";
  const redirectUri =
    config.redirectUri ??
    (typeof globalThis !== "undefined" && "location" in globalThis
      ? `${globalThis.location.origin}/callback`
      : "http://127.0.0.1/callback");
  const scopes = (config.scopes ?? ["openid", "profile"]).join(" ");
  const storage = resolveStorage(config.storage);
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiBase = trimSlash(config.apiBase ?? issuer);
  let discoveryCache: OidcDiscoveryDocument | undefined;

  async function discovery(): Promise<OidcDiscoveryDocument> {
    if (discoveryCache) return discoveryCache;
    const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
    if (!res.ok) {
      throw new Error(`OIDC discovery failed: ${res.status}`);
    }
    discoveryCache = (await res.json()) as OidcDiscoveryDocument;
    return discoveryCache;
  }

  /** In-tab refresh token; never written to StorageLike. */
  let refreshTokenMemory: string | undefined;
  /**
   * Claim bearers seen by `presentClaim`, kept only until the claim is completed.
   * Never written to storage: a claim token is a credential, and the id returned
   * with a presented claim is not one.
   */
  const presentedTokens = new Map<string, string>();

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
    const session = toSession(tokens, false);
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
        throw new Error(`Authorization error: ${error}`);
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const rawPkce = storage.getItem(PKCE_KEY);
      if (!code || !state || !rawPkce) {
        throw new Error("Missing authorization code or PKCE state");
      }
      const pkce = JSON.parse(rawPkce) as {
        state: string;
        codeVerifier: string;
      };
      if (pkce.state !== state) {
        throw new Error("OAuth state mismatch");
      }
      storage.removeItem(PKCE_KEY);
      return exchangeCode(code, pkce.codeVerifier);
    },

    async continueAnonymously() {
      // The control plane mounts provisional sessions here, and answers with its
      // own shape rather than an OAuth token response.
      const res = await fetchImpl(`${apiBase}/v1/principals/provisional`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ clientId }),
      });
      if (!res.ok) {
        throw new Error(`Provisional session failed: ${res.status}`);
      }
      const body = (await res.json()) as {
        accessToken?: string;
        expiresAt?: string;
        principalId?: string;
        tokenType?: string;
      };
      if (!body.accessToken) {
        throw new Error("Provisional session returned no access token");
      }
      const expiresAt =
        body.expiresAt !== undefined ? Date.parse(body.expiresAt) : Number.NaN;
      const session: Session = {
        accessToken: body.accessToken,
        anonymous: true,
        raw: {
          access_token: body.accessToken,
          token_type: body.tokenType ?? "Bearer",
        },
      };
      if (Number.isFinite(expiresAt)) session.expiresAt = expiresAt;
      if (body.principalId !== undefined) session.sub = body.principalId;
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
        throw new ClaimRequestError(
          `presentClaim failed: ${res.status}`,
          res.status,
        );
      }
      const presented = (await res.json()) as ClaimPresentation;
      // Completing needs the claim bearer as well as a principal, and the id in
      // the response is not one. Held in memory for this client only.
      presentedTokens.set(presented.id, token);
      return presented;
    },

    async readClaim(claimId, claimToken) {
      const res = await fetchImpl(`${apiBase}/v1/claims/${claimId}`, {
        headers: { accept: "application/json", "x-claim-token": claimToken },
      });
      if (!res.ok) {
        throw new ClaimRequestError(
          `readClaim failed: ${res.status}`,
          res.status,
        );
      }
      const claim = (await res.json()) as ClaimPresentation;
      // Reading proves the bearer, so completing can follow without repeating it.
      presentedTokens.set(claim.id, claimToken);
      return claim;
    },

    async completeClaim(claimId, decision: ClaimDecision) {
      const session = readSession();
      if (!session) {
        throw new Error("Authentication required to complete claim");
      }
      const claimToken = decision.claimToken ?? presentedTokens.get(claimId);
      if (!claimToken) {
        throw new Error(
          "Claim token required to complete claim — present it with this client, or pass claimToken",
        );
      }
      const body: Record<string, unknown> = {
        acceptedItemIds: decision.acceptedItemIds,
      };
      if (decision.destination !== undefined)
        body.destination = decision.destination;
      if (decision.idempotencyKey !== undefined) {
        body.idempotencyKey = decision.idempotencyKey;
      }
      const res = await fetchImpl(`${apiBase}/v1/claims/${claimId}/complete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${session.accessToken}`,
          "x-claim-token": claimToken,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new ClaimRequestError(
          `completeClaim failed: ${res.status}`,
          res.status,
        );
      }
      // Single-use: nothing else can be done with it, and holding it only widens
      // the window in which it could leak.
      presentedTokens.delete(claimId);
      return (await res.json()) as ClaimPresentation;
    },

    async linkIdentity(options) {
      await this.signIn({ provider: options.provider });
    },

    async signOut() {
      refreshTokenMemory = undefined;
      storage.removeItem(SESSION_KEY);
      storage.removeItem(PKCE_KEY);
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
