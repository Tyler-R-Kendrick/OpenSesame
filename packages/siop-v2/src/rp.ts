/**
 * The relying-party half of a Self-Issued OP login, end to end (ADR 0161).
 *
 * `verifySelfIssuedIdToken` proves a token is well formed and signed by the
 * key it names. It cannot know which login the token answers. This class owns
 * that half, the part an RP most often gets wrong:
 *
 * - **state**: one per login, single use, unguessable, held server-side (or in
 *   the tab), and the only handle by which a response finds its login;
 * - **nonce**: one per login, never reused, compared in constant time;
 * - **audience**: the RP's own `client_id`, nothing else;
 * - **redirect_uri**: the login remembers the exact address it sent and the
 *   response must arrive there (the route that received it, not a claim the
 *   page makes about itself);
 * - **replay**: a state is taken before anything else is checked, a token seen
 *   once is never accepted twice, a login that keeps failing is burned, and
 *   every store is bounded.
 *
 * It never decodes a token without verifying it, and the only identity it
 * returns is a thumbprint a verified signature proves.
 */

import { encodeBase64url } from "./encoding.js";
import {
  type VerifiedSelfIssuedIdToken,
  verifySelfIssuedIdToken,
} from "./id-token.js";
import { STATIC_SELF_ISSUED_ISSUER, assertAllowedIssuer } from "./issuer.js";
import {
  RESPONSE_MODE_FRAGMENT,
  RESPONSE_TYPE_ID_TOKEN,
  SCOPE_OPENID,
  serializeAuthorizationRequest,
} from "./request.js";
import { parseFragmentResponse } from "./response.js";
import {
  DEFAULT_LOGIN_TTL_MS,
  MemoryLoginStore,
  MemoryReplayLedger,
  type PendingSiopLogin,
  type SiopLoginStore,
  type SiopReplayLedger,
} from "./rp-store.js";

export type SiopRpErrorCode =
  | "invalid_configuration"
  | "missing_state"
  | "login_unknown"
  | "login_replayed"
  | "login_expired"
  | "redirect_mismatch"
  | "token_replayed"
  | "provider_error";

const RP_MESSAGES = {
  invalid_configuration: "relying party configuration is not acceptable",
  missing_state: "the response carries no state",
  login_unknown: "no login is waiting for this response",
  login_replayed: "this login was already completed",
  login_expired: "this login expired before the response arrived",
  redirect_mismatch: "the response arrived at a different redirect_uri",
  token_replayed: "this ID Token was already accepted",
  provider_error: "the Self-Issued OP returned an error",
} as const satisfies Record<SiopRpErrorCode, string>;

/**
 * Every refusal that is about the login rather than the token. Token refusals
 * stay `SiopV2Error` (`nonce_mismatch`, `audience_mismatch`, `token_expired`,
 * `signature_invalid`, ...): `error.code` is a stable machine-readable string
 * either way, and neither message carries token contents.
 */
export class SiopRpError extends Error {
  readonly code: SiopRpErrorCode;
  /** The OP's own `error` value (`access_denied`), when it sent one. */
  readonly providerError: string | null;

  constructor(code: SiopRpErrorCode, providerError: string | null = null) {
    super(RP_MESSAGES[code]);
    this.name = "SiopRpError";
    this.code = code;
    this.providerError = providerError;
  }
}

export type SiopRelyingPartyConfig = {
  /** The OP's issuer: `pagesSiopIssuer(...)`, or the one the metadata named. */
  readonly issuer: string;
  /** Where to send the person; defaults to the issuer (the consent route). */
  readonly authorizationEndpoint?: string | undefined;
  /**
   * The application id the person registered (`local_<uuid>`), used when a
   * login does not name one. Pages mints that id in the person's own vault, so
   * a relying party for many people usually passes each person's id to
   * `startLogin` instead.
   */
  readonly clientId: string;
  /** The exact, registered redirect_uri. */
  readonly redirectUri: string;
  readonly store?: SiopLoginStore | undefined;
  readonly ledger?: SiopReplayLedger | undefined;
  readonly loginTtlMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly clockSkewSeconds?: number | undefined;
  readonly maxIatAgeSeconds?: number | undefined;
  /** Milliseconds since the epoch; a test seam. */
  readonly now?: (() => number) | undefined;
  /** Cryptographically secure random bytes; a test seam. */
  readonly randomBytes?: ((length: number) => Uint8Array) | undefined;
};

export type StartSiopLoginInput = {
  /** This person's application id; defaults to the configured one. */
  readonly clientId?: string | undefined;
};

export type SiopLoginStart = {
  /** Redirect the person here. */
  readonly authorizationUrl: string;
  readonly state: string;
  readonly nonce: string;
};

export type CompleteSiopLoginInput = {
  /** The callback's fragment (`#id_token=...&state=...`) or the whole URL. */
  readonly response: string;
  /**
   * The redirect_uri the *server's own route* received this response on.
   * Derive it from the route that handled the request, never from a value the
   * page reports about itself.
   */
  readonly receivedRedirectUri?: string;
};

export type SiopLoginResult = {
  /** The RFC 7638 thumbprint a verified signature proves. Key your user on it. */
  readonly subject: string;
  readonly verified: VerifiedSelfIssuedIdToken;
  readonly state: string;
};

const DEFAULT_MAX_ATTEMPTS = 3;

/** The application ids Pages mints, and the only ones it can have registered. */
const LOCAL_CLIENT_ID = /^local_[0-9a-f-]{36}$/;

function checkedClientId(value: string): string {
  if (!LOCAL_CLIENT_ID.test(value)) {
    throw new SiopRpError("invalid_configuration");
  }
  return value;
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** https, or loopback http for development; no credentials, no fragment. */
function checkedHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SiopRpError("invalid_configuration");
  }
  const loopbackHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new SiopRpError("invalid_configuration");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new SiopRpError("invalid_configuration");
  }
  return url;
}

/** Origin, path and query: the parts of a redirect_uri a server can see. */
function redirectKey(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

async function sha256Base64url(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return encodeBase64url(new Uint8Array(digest));
}

/** A fresh application id in the shape Pages registers: `local_<uuid>`. */
export function generateLocalClientId(
  randomBytes: (length: number) => Uint8Array = secureRandomBytes,
): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `local_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class SiopRelyingParty {
  readonly #config: SiopRelyingPartyConfig;
  readonly #store: SiopLoginStore;
  readonly #ledger: SiopReplayLedger;
  readonly #authorizationEndpoint: string;
  readonly #ttlMs: number;
  readonly #maxAttempts: number;
  readonly #now: () => number;
  readonly #random: (length: number) => Uint8Array;

  constructor(config: SiopRelyingPartyConfig) {
    assertAllowedIssuer(config.issuer);
    if (config.issuer === STATIC_SELF_ISSUED_ISSUER) {
      throw new SiopRpError("invalid_configuration");
    }
    checkedClientId(config.clientId);
    checkedHttpUrl(config.redirectUri);
    const endpoint = checkedHttpUrl(
      config.authorizationEndpoint ?? config.issuer,
    );
    if (endpoint.origin !== new URL(config.issuer).origin) {
      throw new SiopRpError("invalid_configuration");
    }
    this.#config = config;
    this.#authorizationEndpoint = endpoint.href;
    this.#store = config.store ?? new MemoryLoginStore();
    this.#ledger = config.ledger ?? new MemoryReplayLedger();
    this.#ttlMs = config.loginTtlMs ?? DEFAULT_LOGIN_TTL_MS;
    this.#maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#now = config.now ?? (() => Date.now());
    this.#random = config.randomBytes ?? secureRandomBytes;
  }

  /** Begin a login: a fresh state and nonce, remembered, and the URL to open. */
  async startLogin(input: StartSiopLoginInput = {}): Promise<SiopLoginStart> {
    const clientId = checkedClientId(input.clientId ?? this.#config.clientId);
    const nonce = encodeBase64url(this.#random(32));
    const state = encodeBase64url(this.#random(24));
    await this.#store.put(state, {
      clientId,
      nonce,
      redirectUri: this.#config.redirectUri,
      createdAtMs: this.#now(),
      attempts: 0,
    });
    const query = serializeAuthorizationRequest({
      clientId,
      redirectUri: this.#config.redirectUri,
      nonce,
      state,
      scope: SCOPE_OPENID,
      responseType: RESPONSE_TYPE_ID_TOKEN,
      responseMode: RESPONSE_MODE_FRAGMENT,
    });
    return {
      authorizationUrl: `${this.#authorizationEndpoint}?${query}`,
      state,
      nonce,
    };
  }

  /**
   * Finish a login. Resolves with the verified subject or throws; it never
   * resolves for a response that does not answer a login this instance started.
   */
  async completeLogin(input: CompleteSiopLoginInput): Promise<SiopLoginResult> {
    const response = parseFragmentResponse(input.response);
    const state = response.state;
    if (state === null) throw new SiopRpError("missing_state");
    const nowMs = this.#now();
    const pending = await this.#store.take(state);
    if (pending === undefined) {
      const replayed = await this.#ledger.has(`state:${state}`, nowMs);
      throw new SiopRpError(replayed ? "login_replayed" : "login_unknown");
    }
    if (nowMs - pending.createdAtMs > this.#ttlMs) {
      throw new SiopRpError("login_expired");
    }
    if (response.kind === "error") {
      throw new SiopRpError("provider_error", response.error);
    }
    try {
      const result = await this.#verify(
        state,
        pending,
        response.idToken,
        input.receivedRedirectUri,
        nowMs,
      );
      await this.#ledger.claim(
        `state:${state}`,
        pending.createdAtMs + this.#ttlMs,
        nowMs,
      );
      return result;
    } catch (failure) {
      await this.#restore(state, pending);
      throw failure;
    }
  }

  async #verify(
    state: string,
    pending: PendingSiopLogin,
    idToken: string,
    receivedRedirectUri: string | undefined,
    nowMs: number,
  ): Promise<SiopLoginResult> {
    if (receivedRedirectUri !== undefined) {
      const expected = redirectKey(pending.redirectUri);
      const received = redirectKey(receivedRedirectUri);
      if (expected === null || received !== expected) {
        throw new SiopRpError("redirect_mismatch");
      }
    }
    const tokenKey = `token:${await sha256Base64url(idToken)}`;
    if (await this.#ledger.has(tokenKey, nowMs)) {
      throw new SiopRpError("token_replayed");
    }
    const nowSeconds = Math.floor(nowMs / 1000);
    const verified = await verifySelfIssuedIdToken({
      idToken,
      expectedAudience: pending.clientId,
      expectedNonce: pending.nonce,
      profile: { kind: "dynamic", issuer: this.#config.issuer },
      nowSeconds,
      clockSkewSeconds: this.#config.clockSkewSeconds,
      maxIatAgeSeconds: this.#config.maxIatAgeSeconds,
    });
    const keptUntilMs = (verified.exp + 300) * 1000;
    if (!(await this.#ledger.claim(tokenKey, keptUntilMs, nowMs))) {
      throw new SiopRpError("token_replayed");
    }
    return { subject: verified.sub, verified, state };
  }

  /** A failed attempt leaves the login open, a few times, then closes it. */
  async #restore(state: string, pending: PendingSiopLogin): Promise<void> {
    const attempts = pending.attempts + 1;
    if (attempts >= this.#maxAttempts) return;
    await this.#store.put(state, { ...pending, attempts });
  }
}

export function createSiopRelyingParty(
  config: SiopRelyingPartyConfig,
): SiopRelyingParty {
  return new SiopRelyingParty(config);
}
