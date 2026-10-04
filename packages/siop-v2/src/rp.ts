/**
 * The relying-party half of a Self-Issued OP login, end to end (ADR 0161).
 *
 * `verifySelfIssuedIdToken` proves a token is well formed and signed by the
 * key it names. It cannot know which login the token answers, or which browser
 * started it. This class owns that half, the part an RP most often gets wrong:
 *
 * - **binding**: `startLogin` returns a secret the RP keeps in the browser
 *   that started the login (an HttpOnly cookie, the tab's own storage), and
 *   `completeLogin` requires it back. A response someone else obtained, with
 *   their own valid `state`, planted in a victim's browser, finds no matching
 *   binding there and signs nobody in (login CSRF, session fixation);
 * - **state**: one per login, single use, unguessable, held server-side (or in
 *   the tab), and the only handle by which a response finds its login;
 * - **nonce**: one per login, never reused, compared in constant time;
 * - **audience**: the `client_id` the login sent, nothing else;
 * - **redirect_uri**: the login remembers the exact address it sent and the
 *   response must arrive there (the route that received it, not a claim the
 *   page makes about itself), so `receivedRedirectUri` is required;
 * - **replay**: a state is taken before anything else is checked, a token seen
 *   once is never accepted twice, a login that keeps failing is burned, and
 *   every store is bounded and refuses new logins rather than evicting live
 *   ones.
 *
 * It never decodes a token without verifying it, and the only identity it
 * returns is a thumbprint a verified signature proves.
 */

import { constantTimeEquals, encodeBase64url } from "./encoding.js";
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
  type SiopRelyingPartyConfig,
  checkedClientId,
  checkedUrl,
  redirectKey,
} from "./rp-config.js";
import { SiopRpError } from "./rp-error.js";
import {
  DEFAULT_LOGIN_TTL_MS,
  MemoryLoginStore,
  MemoryReplayLedger,
  type PendingSiopLogin,
  type SiopLoginStore,
  type SiopReplayLedger,
} from "./rp-store.js";

export { SiopRpError, type SiopRpErrorCode } from "./rp-error.js";
export type { SiopRelyingPartyConfig } from "./rp-config.js";

export type StartSiopLoginInput = {
  /** This person's application id; defaults to the configured one. */
  readonly clientId?: string | undefined;
  /** One of the configured allowed redirect_uris; defaults to `redirectUri`. */
  readonly redirectUri?: string | undefined;
};

export type SiopLoginStart = {
  /** Redirect the person here. */
  readonly authorizationUrl: string;
  readonly state: string;
  readonly nonce: string;
  /**
   * A secret for the browser that is starting this login. Hand it to that
   * browser and to nobody else (`Set-Cookie: __Host-…; HttpOnly; Secure;
   * SameSite=Lax`, or the tab's own storage), and pass it back to
   * `completeLogin` from the request that carries the response.
   */
  readonly binding: string;
};

export type CompleteSiopLoginInput = {
  /** The callback's fragment (`#id_token=...&state=...`) or the whole URL. */
  readonly response: string;
  /** The binding this browser was given at `startLogin`; empty if it has none. */
  readonly binding: string;
  /**
   * The redirect_uri, query included, the *server's own route* received this
   * response on. Derive it from the request that handled it, never from a value
   * the page reports about itself.
   */
  readonly receivedRedirectUri: string;
};

export type SiopLoginResult = {
  /** The RFC 7638 thumbprint a verified signature proves. Key your user on it. */
  readonly subject: string;
  readonly verified: VerifiedSelfIssuedIdToken;
  readonly state: string;
};

const DEFAULT_MAX_ATTEMPTS = 3;

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
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
  readonly #redirects: ReadonlySet<string>;
  readonly #ttlMs: number;
  readonly #maxAttempts: number;
  readonly #now: () => number;
  readonly #random: (length: number) => Uint8Array;

  constructor(config: SiopRelyingPartyConfig) {
    const allowLoopbackHttp = config.allowLoopbackHttp === true;
    assertAllowedIssuer(config.issuer);
    if (config.issuer === STATIC_SELF_ISSUED_ISSUER) {
      throw new SiopRpError("invalid_configuration");
    }
    const issuer = checkedUrl(config.issuer, {
      allowLoopbackHttp,
      allowQuery: false,
    });
    checkedClientId(config.clientId);
    const redirects = [
      config.redirectUri,
      ...(config.allowedRedirectUris ?? []),
    ];
    for (const redirect of redirects) {
      checkedUrl(redirect, { allowLoopbackHttp, allowQuery: true });
    }
    const endpoint = checkedUrl(config.authorizationEndpoint ?? config.issuer, {
      allowLoopbackHttp,
      allowQuery: false,
    });
    if (endpoint.origin !== issuer.origin) {
      throw new SiopRpError("invalid_configuration");
    }
    this.#config = config;
    this.#authorizationEndpoint = endpoint.href;
    this.#redirects = new Set(redirects);
    this.#now = config.now ?? (() => Date.now());
    this.#ttlMs = config.loginTtlMs ?? DEFAULT_LOGIN_TTL_MS;
    this.#store =
      config.store ?? new MemoryLoginStore(undefined, this.#ttlMs, this.#now);
    this.#ledger = config.ledger ?? new MemoryReplayLedger();
    this.#maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#random = config.randomBytes ?? secureRandomBytes;
  }

  /**
   * Begin a login: a fresh state, nonce and binding, remembered, and the URL to
   * open. Throws `capacity_exceeded` when the store is full of live logins.
   */
  async startLogin(input: StartSiopLoginInput = {}): Promise<SiopLoginStart> {
    const clientId = checkedClientId(input.clientId ?? this.#config.clientId);
    const redirectUri = input.redirectUri ?? this.#config.redirectUri;
    if (!this.#redirects.has(redirectUri)) {
      throw new SiopRpError("invalid_configuration");
    }
    const nonce = encodeBase64url(this.#random(32));
    const state = encodeBase64url(this.#random(24));
    const binding = encodeBase64url(this.#random(32));
    const kept = await this.#store.put(state, {
      clientId,
      binding,
      nonce,
      redirectUri,
      createdAtMs: this.#now(),
      attempts: 0,
    });
    if (!kept) throw new SiopRpError("capacity_exceeded");
    const query = serializeAuthorizationRequest({
      clientId,
      redirectUri,
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
      binding,
    };
  }

  /**
   * Finish a login. Resolves with the verified subject or throws; it never
   * resolves for a response that does not answer a login this instance started
   * *for the browser that presents it*.
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
    // Before anything else a response can do to the login: the browser that
    // presents it must be the one that started it. A different browser leaves
    // the login exactly as it was, so a forged `#error=…&state=…` or a planted
    // response cannot close or complete somebody else's login.
    if (
      input.binding.length === 0 ||
      !constantTimeEquals(input.binding, pending.binding)
    ) {
      await this.#store.put(state, pending);
      throw new SiopRpError("login_unknown");
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
    receivedRedirectUri: string,
    nowMs: number,
  ): Promise<SiopLoginResult> {
    const expected = redirectKey(pending.redirectUri);
    const received = redirectKey(receivedRedirectUri);
    if (expected === null || received !== expected) {
      throw new SiopRpError("redirect_mismatch");
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
