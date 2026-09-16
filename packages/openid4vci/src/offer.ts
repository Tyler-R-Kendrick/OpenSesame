/**
 * Credential Offers, and the single-use pre-authorized code behind them.
 *
 * A Credential Offer is a thing that ends up on a screen — rendered as a QR
 * code, printed in a terminal, pasted into a chat. It is photographed by
 * whoever is standing behind the End-User and cached by whatever scanned it.
 * That is the same threat model as `os-domain`'s interaction references, and
 * this file takes the same position: **the link is worth nothing on its own.**
 *
 * OpenID4VCI 1.0 §4.1 offers two ways to carry an offer. `credential_offer`
 * puts the whole object, pre-authorized code included, in the URL. This
 * package will not emit that form. It emits only `credential_offer_uri`, a
 * reference to an `https` resource the wallet must fetch — so the secret is
 * exchanged over TLS with an issuer that can rate-limit, expire and audit the
 * fetch, instead of being handed to a camera. §13.5's own guidance points the
 * same way; we simply do not implement the other branch, because a branch
 * that exists gets used.
 *
 * {@link assertOfferLinkIsClean} is not a test helper. It runs on the
 * production path, on every link, before the link is returned, and it checks
 * the link's parameter names against `FORBIDDEN_URL_PARAMS` — the same
 * deny-list `os-domain` uses for interaction URLs — *and* checks that the
 * minted code does not appear anywhere in the link's bytes. A link builder
 * that would ship a bearer to a screen fails loudly instead.
 *
 * The pre-authorized code itself is 256 bits of randomness, single-use, and
 * short-lived (§4.1.1: "MUST be short lived and single use"). Redemption
 * answers unknown, expired, already-spent and wrong-transaction-code with one
 * identical refusal, so the token endpoint cannot be turned into a probe for
 * which offers exist.
 *
 * **F10 — an offer by reference is still a bearer.** Emitting only
 * `credential_offer_uri` keeps the code off the screen, but the code is still
 * served *from* the offer resource: whoever can fetch that resource can redeem
 * it. So {@link createCredentialOffer} refuses to mint an offer that has
 * neither a Transaction Code nor a declaration that its redemption is
 * protected. One of the two must be true: either a second factor is demanded
 * out of band (`txCode`), or the caller asserts the offer resource and the
 * token endpoint are gated by the same authentication (`protectedRedemption`),
 * which {@link PreAuthorizedGrant.requiresProtectedRedemption} then carries to
 * the redemption path so a route can enforce it rather than assume it.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  FORBIDDEN_URL_PARAMS,
  type JsonObject,
  isString,
} from "@opensesame/os-domain";
import { refuse } from "./errors.js";
import { parseCredentialIssuer } from "./metadata.js";

/** RFC-registered grant type URN for the Pre-Authorized Code Flow (§G.1.1). */
export const PRE_AUTHORIZED_CODE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:pre-authorized_code";

/**
 * The custom scheme a wallet registers (§12.1, §G.7.1).
 *
 * Used when the issuer cannot discover a wallet's own Credential Offer
 * Endpoint, which is every case this package handles.
 */
export const CREDENTIAL_OFFER_SCHEME = "openid-credential-offer://";

/** 32 bytes → 256 bits. Guessing is not a threat; enumeration is not either. */
const CODE_BYTES = 32;

/**
 * Default lifetime of a pre-authorized code.
 *
 * Five minutes is long enough for a human to notice a QR code, unlock a phone
 * and open a wallet, and short enough that a photograph of the *fetched* offer
 * is worthless by the time it is read off a monitor. §4.1.1 says only "short
 * lived"; this is our reading of it, and it is overridable per offer because
 * an offer delivered by e-mail is a different ceremony from one on a screen.
 */
export const DEFAULT_PRE_AUTHORIZED_CODE_TTL_SECONDS = 300;

/** Ceiling on the TTL a caller may ask for. */
const MAX_PRE_AUTHORIZED_CODE_TTL_SECONDS = 3600;

/** §4.1.1 caps the Transaction Code description at 300 characters. */
const MAX_TX_CODE_DESCRIPTION = 300;

export type TransactionCodeInputMode = "numeric" | "text";

/**
 * A Transaction Code requirement, as advertised in the offer.
 *
 * The presence of this object — even empty — is what tells a wallet a code
 * will be demanded at the token endpoint. Its purpose (§4.1.1) is precisely
 * the shoulder-surfing case: it binds the pre-authorized code to a second
 * channel, so scanning the QR is not sufficient.
 */
export interface TransactionCodeSpec {
  readonly inputMode?: TransactionCodeInputMode;
  readonly length?: number;
  readonly description?: string;
}

export interface CredentialOfferInput {
  /** Credential Issuer Identifier; must match the issued metadata exactly. */
  readonly credentialIssuer: string;
  /** Non-empty. Keys of `credential_configurations_supported`. */
  readonly credentialConfigurationIds: readonly string[];
  /**
   * The `https` URL at which *this* offer object will be served.
   *
   * The caller supplies it because only the caller knows its routing. §4.1.3
   * asks that it be unique per offer so the offer cannot be served from a
   * cache after its code has been spent; {@link createCredentialOffer} cannot
   * verify uniqueness, so this is the one contract it hands back to the
   * caller rather than enforcing.
   */
  readonly offerUri: string;
  /** Present to demand a Transaction Code out of band. */
  readonly txCode?: TransactionCodeSpec;
  /** The literal Transaction Code, when `txCode` is present. */
  readonly txCodeValue?: string;
  /**
   * Assert that the offer resource and the token endpoint are gated by the
   * same authentication (F10).
   *
   * This is the alternative to a Transaction Code, not an addition a caller
   * can skip: an offer with no `txCode` and no `protectedRedemption` is
   * refused, because a by-reference offer with neither is a bearer on a
   * screen. Setting this to `true` is a promise the caller keeps at the HTTP
   * boundary — {@link PreAuthorizedGrant.requiresProtectedRedemption} carries
   * it to redemption so the promise can be checked rather than trusted.
   */
  readonly protectedRedemption?: boolean;
  readonly ttlSeconds?: number;
  readonly now?: Date;
}

/**
 * The issuer-side record for one offer.
 *
 * Separate from the offer object because the two go to different places: the
 * object is served to a wallet, the record is registered with a store and
 * never leaves the issuer. `txCodeValue` in particular exists only here.
 */
export interface PreAuthorizedGrant {
  readonly code: string;
  readonly credentialConfigurationIds: readonly string[];
  readonly expiresAt: Date;
  readonly txCodeValue?: string;
  /**
   * The offer relied on an authenticated fetch rather than a Transaction Code
   * (F10). Redemption of such a grant MUST be gated by the same authentication
   * that gated the offer resource; the code alone is not sufficient. A store
   * cannot enforce this — it does not see the caller — so it is returned in
   * {@link RedeemedGrant} for the redemption route to check.
   */
  readonly requiresProtectedRedemption: boolean;
}

export interface CreatedCredentialOffer {
  /** The JSON object to serve at `offerUri`. Contains the code. */
  readonly offer: JsonObject;
  /** The `https` URL the wallet will fetch. */
  readonly offerUri: string;
  /** `openid-credential-offer://?credential_offer_uri=...`. Contains nothing. */
  readonly offerLink: string;
  /** Register this with a {@link PreAuthorizedCodeStore}. */
  readonly grant: PreAuthorizedGrant;
}

/**
 * Refuse a link that carries anything a holder of the link could spend.
 *
 * Two independent checks, because they fail differently:
 *
 * 1. **Parameter names** against `FORBIDDEN_URL_PARAMS`. Catches a future
 *    caller who adds `?code=` or `?credential=` to the link for convenience.
 *    The list is shared with the rest of OpenSesame precisely so that the
 *    answer to "is this name a bearer" is decided in one place.
 * 2. **The code's own bytes**, anywhere in the link, in any position. Catches
 *    the case a name-based check cannot: the same secret under a name nobody
 *    thought to deny, or spliced into a path segment.
 *
 * Both run before the link is returned, so a violation is a thrown error at
 * mint time rather than a leaked secret at scan time.
 */
export function assertOfferLinkIsClean(
  link: string,
  secrets: readonly string[],
): void {
  const withoutFragment = link.split("#");
  const [beforeFragment, ...fragmentParts] = withoutFragment;
  if (beforeFragment === undefined) refuse("offer_link_would_leak");
  const queryStart = beforeFragment.indexOf("?");
  const query = queryStart < 0 ? "" : beforeFragment.slice(queryStart + 1);
  // A fragment is never sent to a server, which is exactly why people put
  // secrets there. It is checked identically.
  const fragment = fragmentParts.join("#");

  for (const section of [query, fragment]) {
    if (section.length === 0) continue;
    for (const [name] of new URLSearchParams(section)) {
      if (FORBIDDEN_URL_PARAMS.includes(name.toLowerCase())) {
        refuse("offer_link_would_leak");
      }
    }
  }

  for (const secret of secrets) {
    if (secret.length === 0) continue;
    // Percent-encoding would hide a raw match, so both spellings are checked.
    if (link.includes(secret) || link.includes(encodeURIComponent(secret))) {
      refuse("offer_link_would_leak");
    }
  }
}

function requireHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    refuse("invalid_offer");
  }
  if (url.protocol !== "https:") refuse("invalid_offer");
  return url;
}

function buildTxCodeObject(spec: TransactionCodeSpec): JsonObject {
  const object: JsonObject = {};
  if (spec.inputMode !== undefined) object.input_mode = spec.inputMode;
  if (spec.length !== undefined) {
    if (!Number.isInteger(spec.length) || spec.length <= 0)
      refuse("invalid_offer");
    object.length = spec.length;
  }
  if (spec.description !== undefined) {
    if (spec.description.length > MAX_TX_CODE_DESCRIPTION)
      refuse("invalid_offer");
    object.description = spec.description;
  }
  return object;
}

/**
 * Mint one offer.
 *
 * Returns three things that must go to three different places: the object to
 * serve, the link to display, and the record to store. Keeping them in one
 * return value is deliberate — a caller cannot display a link for an offer it
 * forgot to register, because it had to destructure the record to ignore it.
 */
export function createCredentialOffer(
  input: CredentialOfferInput,
): CreatedCredentialOffer {
  const issuer = parseCredentialIssuer(input.credentialIssuer);
  const configurationIds = input.credentialConfigurationIds ?? [];
  if (configurationIds.length === 0) refuse("invalid_offer");
  for (const id of configurationIds) {
    if (!isString(id) || id.length === 0) refuse("invalid_offer");
  }
  const offerUri = requireHttpsUrl(input.offerUri);

  const ttl = input.ttlSeconds ?? DEFAULT_PRE_AUTHORIZED_CODE_TTL_SECONDS;
  if (
    !Number.isFinite(ttl) ||
    ttl <= 0 ||
    ttl > MAX_PRE_AUTHORIZED_CODE_TTL_SECONDS
  ) {
    refuse("invalid_offer");
  }

  // A Transaction Code that is advertised but never checked is worse than no
  // Transaction Code: the wallet's UI promises the End-User a second factor
  // that does not exist. The two fields are required together.
  if ((input.txCode === undefined) !== (input.txCodeValue === undefined)) {
    refuse("invalid_offer");
  }
  if (input.txCodeValue !== undefined && input.txCodeValue.length === 0) {
    refuse("invalid_offer");
  }

  // F10. A by-reference offer serves its code from the offer resource, so an
  // offer that demands no Transaction Code and does not declare its redemption
  // protected is a bearer waiting to be fetched. Refuse to mint one. The two
  // are not mutually exclusive — a caller may set both — but at least one must
  // hold.
  const protectedRedemption = input.protectedRedemption === true;
  if (input.txCode === undefined && !protectedRedemption) {
    refuse("offer_redemption_unprotected");
  }

  const now = input.now ?? new Date();
  const code = randomBytes(CODE_BYTES).toString("base64url");

  const grantParameters: JsonObject = { "pre-authorized_code": code };
  if (input.txCode !== undefined) {
    grantParameters.tx_code = buildTxCodeObject(input.txCode);
  }

  const offer: JsonObject = {
    credential_issuer: issuer.identifier,
    credential_configuration_ids: [...configurationIds],
    grants: { [PRE_AUTHORIZED_CODE_GRANT_TYPE]: grantParameters },
  };

  const offerLink = `${CREDENTIAL_OFFER_SCHEME}?credential_offer_uri=${encodeURIComponent(
    offerUri.href,
  )}`;
  assertOfferLinkIsClean(
    offerLink,
    input.txCodeValue === undefined ? [code] : [code, input.txCodeValue],
  );

  // Two literals rather than a conditional spread: `txCodeValue` absent and
  // `txCodeValue: undefined` are different objects to `redeem`, and an
  // expression that hides the difference is how they get conflated.
  const base = {
    code,
    credentialConfigurationIds: [...configurationIds],
    expiresAt: new Date(now.getTime() + ttl * 1000),
    requiresProtectedRedemption: protectedRedemption,
  };
  const grant: PreAuthorizedGrant =
    input.txCodeValue === undefined
      ? base
      : { ...base, txCodeValue: input.txCodeValue };

  return { offer, offerUri: offerUri.href, offerLink, grant };
}

/** What a successful redemption proves. */
export interface RedeemedGrant {
  readonly credentialConfigurationIds: readonly string[];
  /**
   * Carried from {@link PreAuthorizedGrant}. When true, the redemption route
   * must confirm the caller is the authenticated principal the offer was
   * bound to before it proceeds — the pre-authorized code alone does not
   * authorize issuance for a protected offer (F10).
   */
  readonly requiresProtectedRedemption: boolean;
}

/**
 * Evaluate a redemption against a grant: expiry, then Transaction Code.
 *
 * Extracted from the in-memory store so that every store — this one, and the
 * durable one a horizontally scaled deployment injects — reaches the same
 * decision through the same constant-time comparison, rather than each
 * re-deriving the no-oracle rule and the Transaction Code check. A store's
 * only remaining job is the atomic spend: fetch-and-remove the grant, then
 * hand it here. Refuses unknown (the store passes nothing), expired and
 * wrong-transaction-code with one identical `pre_authorized_code_rejected`.
 */
export function redeemGrant(
  grant: PreAuthorizedGrant,
  txCode: string | undefined,
  now: Date,
): RedeemedGrant {
  if (grant.expiresAt.getTime() <= now.getTime()) {
    refuse("pre_authorized_code_rejected");
  }
  const expected = grant.txCodeValue;
  if (expected !== undefined) {
    if (txCode === undefined || !constantTimeEquals(expected, txCode)) {
      refuse("pre_authorized_code_rejected");
    }
  } else if (txCode !== undefined) {
    // A code supplied where none was demanded means the wallet is following a
    // different offer than the one we minted. §6.1 makes `tx_code` valid only
    // when the offer asked for it.
    refuse("pre_authorized_code_rejected");
  }
  return {
    credentialConfigurationIds: grant.credentialConfigurationIds,
    requiresProtectedRedemption: grant.requiresProtectedRedemption,
  };
}

/**
 * Where pre-authorized codes live between minting and redemption.
 *
 * Injectable because the store is the one stateful thing in the issuance path
 * and the right implementation depends on the deployment: a single process
 * wants a `Map`, a horizontally scaled gateway wants something with a
 * compare-and-delete primitive. The interface is deliberately narrow — there
 * is no `get`, because a caller that can read a grant without spending it can
 * build a replay by accident.
 */
export interface PreAuthorizedCodeStore {
  register(grant: PreAuthorizedGrant): Promise<void>;
  /**
   * Spend a code, or refuse.
   *
   * Implementations MUST refuse unknown, expired, already-redeemed and
   * wrong-transaction-code with the same `pre_authorized_code_rejected`
   * error and no distinguishing side effect. That is the whole contract, and
   * the refusal must arrive as a rejection rather than a synchronous throw.
   */
  redeem(code: string, txCode?: string, now?: Date): Promise<RedeemedGrant>;
}

/**
 * Constant-time comparison for a low-entropy secret.
 *
 * The pre-authorized code is 256 random bits and its lookup is a hash-map
 * probe, which leaks nothing usable. The *Transaction Code* is different: §4.1.1
 * describes four numeric digits. A byte-by-byte `===` over four digits is a
 * genuine oracle, so it gets `timingSafeEqual`, with the length difference
 * absorbed by comparing a padded copy rather than returning early.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  const width = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(width);
  const paddedRight = Buffer.alloc(width);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  return (
    timingSafeEqual(paddedLeft, paddedRight) && left.length === right.length
  );
}

interface StoredGrant {
  readonly grant: PreAuthorizedGrant;
}

/**
 * Bounded in-memory store.
 *
 * The bound matters and its overflow policy is a security choice, not a
 * default. Codes are registered only by the issuer's own offer-creation path,
 * which is behind whatever gate creates offers — so an attacker cannot flood
 * this map, and hitting the ceiling means *we* created more live offers than
 * we planned for. Refusing to register a new one is therefore the safe answer:
 * it degrades new issuance while leaving every outstanding grant redeemable.
 * (Contrast `MemoryNonceStore`, whose input is unauthenticated and which
 * therefore evicts instead. The two policies are opposite on purpose.)
 */
export class MemoryPreAuthorizedCodeStore implements PreAuthorizedCodeStore {
  readonly #entries = new Map<string, StoredGrant>();
  readonly #capacity: number;

  constructor(capacity = 1024) {
    if (!Number.isInteger(capacity) || capacity <= 0) refuse("invalid_offer");
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#entries.size;
  }

  async register(grant: PreAuthorizedGrant): Promise<void> {
    this.#sweep(new Date());
    if (this.#entries.size >= this.#capacity) refuse("invalid_offer");
    this.#entries.set(grant.code, { grant });
  }

  async redeem(
    code: string,
    txCode?: string,
    now?: Date,
  ): Promise<RedeemedGrant> {
    const at = now ?? new Date();
    const stored = this.#entries.get(code);
    // Delete before every other decision. An expired or transaction-code-
    // mismatched grant is burned rather than left for a second attempt, so a
    // four-digit Transaction Code cannot be brute-forced against a live code.
    if (stored !== undefined) this.#entries.delete(code);

    if (stored === undefined) refuse("pre_authorized_code_rejected");
    // The expiry and Transaction Code checks live in `redeemGrant`, shared
    // with every other store so the no-oracle rule is written once.
    return redeemGrant(stored.grant, txCode, at);
  }

  #sweep(now: Date): void {
    for (const [code, stored] of this.#entries) {
      if (stored.grant.expiresAt.getTime() <= now.getTime()) {
        this.#entries.delete(code);
      }
    }
  }
}
