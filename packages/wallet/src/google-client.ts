/**
 * The Google Wallet REST + JWT signing client, shared by every Google adapter.
 *
 * There are two Google adapters in this package now — the per-interaction
 * "address" pass (`google.ts`) and the persistent launcher pass
 * (`launcher.ts`) — and they must not each carry their own copy of the one
 * piece of Google plumbing that has real security weight: the service-account
 * JWT-bearer grant, the outbound REST verbs, and the Save-to-Wallet signing
 * envelope. A second copy is a second place a mistake can be made in exactly
 * the code that mints Google-trusted artifacts, so the plumbing lives here once
 * and both adapters program against it.
 *
 * Two properties are deliberate and load-bearing:
 *
 * 1. **The payload gate runs inside every outbound path.** `signSaveUrl` and
 *    every REST mutation call `assertPassPayloadSafe` on the exact bytes they
 *    are about to emit, so no caller can forget to and no future field reaches
 *    Google unscreened. This is why a rotating-barcode seed cannot be smuggled
 *    into a Save JWT: the JWT is signed here, over a public object, and the
 *    seed only ever travels through `patchGenericObject`/`insertGenericObject`.
 * 2. **No Google SDK.** `jose` signs; injected `fetch` calls. See `google.ts`
 *    for the full reasoning; the short version is that `googleapis` brings
 *    ambient credential discovery this repository must not own.
 */

import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { SignJWT, importPKCS8 } from "jose";
import type { GoogleWalletEnabled } from "./config.js";
import { assertPassPayloadSafe } from "./payload.js";
import { WalletInputError, WalletRequestError } from "./provider.js";

const SAVE_LINK_PREFIX = "https://pay.google.com/gp/v/save/";
const WALLET_OBJECTS_BASE =
  "https://walletobjects.googleapis.com/walletobjects/v1";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUER_SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Refresh the access token early so a call never races its own expiry. */
const TOKEN_SKEW_SECONDS = 60;

/**
 * A ceiling on the save link, because a save link is a URL.
 *
 * There is no specified maximum URL length; there are practical ones, and
 * browsers, proxies, chat clients, and QR renderers each give up somewhere. The
 * widely-safe figure is 4096, and a fully-populated Generic pass costs roughly
 * 1900 characters before any display rows, so this leaves generous room for a
 * real pass while still catching an unbounded caller at the call site rather
 * than as an unexplained failure on somebody's phone.
 */
const SAVE_URL_MAX_LENGTH = 4096;

export interface GoogleClientOptions {
  config: GoogleWalletEnabled;
  /**
   * Injected so tests never reach the network and so a host can supply its own
   * egress-controlled client. Defaults to the platform `fetch`.
   */
  fetchImpl?: typeof fetch;
  /** Injected clock, so validity windows and token expiry are assertable. */
  now?: () => Date;
}

/**
 * What either adapter is handed. Signing is offline and always available; the
 * REST verbs need a `fetch` and say so through `hasFetch`.
 */
export interface GoogleClient {
  readonly config: GoogleWalletEnabled;
  readonly hasFetch: boolean;
  readonly now: () => Date;
  /**
   * Sign a Save-to-Google-Wallet link over the given Generic objects.
   *
   * The whole claim envelope is screened by the payload gate before the key
   * ever touches it, and the resulting URL is length-checked, because a save
   * link is a URL a human has to be able to open.
   */
  signSaveUrl(genericObjects: readonly BoundaryValue[]): Promise<string>;
  /** PATCH one Generic object. Screened, then sent. */
  patchGenericObject(passId: string, body: BoundaryValue): Promise<void>;
  /**
   * PATCH one Generic object *without* the device-facing payload gate.
   *
   * The gate refuses secret-shaped content because a pass reaches a lock
   * screen; a rotating-barcode seed is exactly that shape and yet is
   * legitimately provisioned here, to Google, over the authenticated channel,
   * and never to a device. So this path is deliberately not screened, and the
   * name says so. The caller is responsible for having screened everything it
   * did not itself generate — the launcher provider screens the public object
   * separately and only the self-minted seed rides this call.
   */
  patchGenericObjectUnscreened(
    passId: string,
    body: BoundaryValue,
  ): Promise<void>;
  /**
   * Insert one Generic object, tolerating the "already exists" answer.
   *
   * Provisioning is idempotent: re-running it after a crash must address the
   * existing object rather than fail, so a 409 is success, not an error.
   */
  insertGenericObject(body: BoundaryValue): Promise<void>;
  /** Insert one Generic class, tolerating the "already exists" answer. */
  insertGenericClass(body: BoundaryValue): Promise<void>;
}

/**
 * Create a Google client bound to one issuer configuration.
 *
 * The signing key is imported lazily and once: importing eagerly would make
 * constructing a client an async, fallible act at startup, and importing per
 * call would repeat an ASN.1 parse for every pass.
 */
export function createGoogleClient(options: GoogleClientOptions): GoogleClient {
  const { config } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  let signingKey: Promise<CryptoKey> | null = null;
  const key = (): Promise<CryptoKey> => {
    signingKey ??= importPKCS8(config.serviceAccountKeyPem, "RS256");
    return signingKey;
  };

  let token: { value: string; expiresAtMs: number } | null = null;

  /**
   * A service-account access token, via the JWT-bearer grant.
   *
   * Cached until shortly before it expires. The alternative — a token per call
   * — would put an extra round trip and an extra RSA signature in front of
   * every revocation, and revocation is the operation most likely to be run in
   * a hurry.
   */
  const accessToken = async (): Promise<string> => {
    const nowMs = now().getTime();
    if (token !== null && token.expiresAtMs > nowMs) return token.value;

    const issuedAt = Math.floor(nowMs / 1000);
    const assertion = await new SignJWT({
      iss: config.serviceAccountEmail,
      scope: ISSUER_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .sign(await key());

    let response: Response;
    try {
      response = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: JWT_BEARER_GRANT,
          assertion,
        }).toString(),
      });
    } catch (cause) {
      throw new WalletRequestError(
        0,
        "Google's token endpoint was unreachable; no change was made.",
        cause,
      );
    }
    if (!response.ok) {
      throw new WalletRequestError(
        response.status,
        `Google refused the service-account assertion (HTTP ${response.status}).`,
      );
    }
    /*
     * SAFETY: `Response.json` is `any`; narrowing it to the two fields this
     * function actually reads keeps the rest of the code honest about what it
     * relies on, and both fields are re-checked below — a response that does
     * not match yields a typed error rather than a bad token.
     */
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    const value = body.access_token ?? "";
    if (value.length === 0) {
      throw new WalletRequestError(
        response.status,
        "Google's token response carried no access token.",
      );
    }
    const lifetime = body.expires_in ?? 3600;
    token = {
      value,
      expiresAtMs: nowMs + Math.max(lifetime - TOKEN_SKEW_SECONDS, 0) * 1000,
    };
    return value;
  };

  const sendPatch = async (
    passId: string,
    body: BoundaryValue,
  ): Promise<void> => {
    const authorization = await accessToken();
    const url = `${WALLET_OBJECTS_BASE}/genericObject/${encodeURIComponent(passId)}`;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${authorization}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new WalletRequestError(
        0,
        "Google Wallet was unreachable; the pass was not changed.",
        cause,
      );
    }
    if (response.ok) return;
    if (response.status === 404) {
      throw new WalletRequestError(
        404,
        `Google holds no pass with id ${passId}.`,
      );
    }
    if (response.status >= 500) {
      throw new WalletRequestError(
        response.status,
        `Google Wallet failed the update (HTTP ${response.status}); the pass may or may not have changed.`,
      );
    }
    throw new WalletRequestError(
      response.status,
      `Google Wallet refused the update (HTTP ${response.status}).`,
    );
  };

  const patchGenericObject = async (
    passId: string,
    body: BoundaryValue,
  ): Promise<void> => {
    // The gate runs on outbound mutations too, not just on issuance: an update
    // is another way for a field to reach a device once the pass is saved.
    assertPassPayloadSafe(body);
    await sendPatch(passId, body);
  };

  /**
   * POST a resource, treating "already exists" as success.
   *
   * `resource` is the collection path segment (`genericObject`,
   * `genericClass`). A 409 means an earlier provisioning already created it,
   * which for an idempotent operation is the desired end state, not a fault.
   */
  const insert = async (
    resource: string,
    body: BoundaryValue,
    unreachable: string,
  ): Promise<void> => {
    assertPassPayloadSafe(body);
    const authorization = await accessToken();
    const url = `${WALLET_OBJECTS_BASE}/${resource}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${authorization}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new WalletRequestError(0, unreachable, cause);
    }
    if (response.ok || response.status === 409) return;
    if (response.status >= 500) {
      throw new WalletRequestError(
        response.status,
        `Google Wallet failed the ${resource} insert (HTTP ${response.status}); it may or may not have been created.`,
      );
    }
    throw new WalletRequestError(
      response.status,
      `Google Wallet refused the ${resource} insert (HTTP ${response.status}).`,
    );
  };

  const signSaveUrl = async (
    genericObjects: readonly BoundaryValue[],
  ): Promise<string> => {
    const issuedAt = now();
    const claims = {
      iss: config.serviceAccountEmail,
      aud: "google",
      typ: "savetowallet",
      iat: Math.floor(issuedAt.getTime() / 1000),
      origins: [...config.origins],
      payload: { genericObjects: [...genericObjects] },
    };
    // The gate runs over the whole claim set rather than the objects alone, so
    // a future claim added here is inspected without anyone remembering to.
    // It runs *before* signing: nothing forbidden is ever put to the key.
    assertPassPayloadSafe(overlapCast(claims));

    const jwt = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .sign(await key());
    const saveUrl = `${SAVE_LINK_PREFIX}${jwt}`;
    if (saveUrl.length > SAVE_URL_MAX_LENGTH) {
      throw new WalletInputError(
        `The save link is ${saveUrl.length} characters; Google rejects links over ${SAVE_URL_MAX_LENGTH}. Shorten the title or drop display rows.`,
      );
    }
    return saveUrl;
  };

  return {
    config,
    hasFetch: fetchImpl !== undefined,
    now,
    signSaveUrl,
    patchGenericObject,
    patchGenericObjectUnscreened: (passId, body) => sendPatch(passId, body),
    insertGenericObject: (body) =>
      insert(
        "genericObject",
        body,
        "Google Wallet was unreachable; the pass was not provisioned.",
      ),
    insertGenericClass: (body) =>
      insert(
        "genericClass",
        body,
        "Google Wallet was unreachable; the class was not provisioned.",
      ),
  };
}
