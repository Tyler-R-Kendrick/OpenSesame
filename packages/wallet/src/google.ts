/**
 * Google Wallet Generic Pass adapter.
 *
 * A Generic pass is the right shape for an OpenSesame interaction: it has a
 * title, a couple of display rows, a barcode, and a validity window, and it
 * carries no vertical-specific semantics that would imply a loyalty balance or
 * a boarding sequence that we do not have.
 *
 * Two things about this adapter are worth reading before changing it.
 *
 * **Issuing is offline.** The Save to Google Wallet link is a JWT that we sign
 * ourselves; Google validates it when the human taps it. Nothing is called, so
 * issuance keeps working through a Google outage, a proxy failure, or a
 * revoked API enablement — which is also why `capabilities()` reports
 * `available` without probing anything (see `provider.ts`). Only `updatePass`
 * and `revokePass` talk to `walletobjects.googleapis.com`, and they are the
 * only capabilities that go false when no `fetch` exists.
 *
 * **No Google SDK.** `googleapis` is a very large dependency tree for two REST
 * calls and one JWT-bearer grant, and it brings its own ambient credential
 * discovery — Application Default Credentials will happily pick up a metadata
 * server or a stray `~/.config/gcloud` file. An adapter that can silently
 * authenticate as something other than the configured service account is not
 * something this repository should own. `jose` (already pinned repo-wide at
 * 6.2.8) signs; injected `fetch` calls.
 *
 * ## Rotating barcodes
 *
 * `capabilities().rotatingBarcode` is `false`, and that is a decision rather
 * than a gap. Google's rotating barcode is a mitigation for barcodes that *are*
 * bearers — a season ticket where possession of the image is admission, so a
 * screenshot has to stop working. Ours is not one: the barcode holds an opaque
 * interaction reference (ADR 0086) that authorizes nothing, and answering the
 * interaction still costs an authenticated approver and a proof bound to the
 * request digest. Rotation would therefore buy no security at all, while
 * costing a great deal: Google's implementation requires provisioning a
 * long-lived shared TOTP seed to Google, from which valid barcode payloads are
 * derived. That is a real secret, held by a third party, minted to mitigate a
 * replay risk we designed out of existence. Reporting `false` is the honest
 * answer; reporting `true` and rotating a URL on a timer would be theatre.
 */

import { createHash } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import type { InteractionKind } from "@opensesame/os-domain";
import { SignJWT, importPKCS8 } from "jose";
import type { GoogleWalletEnabled } from "./config.js";
import { assertPassPayloadSafe } from "./payload.js";
import {
  type WalletCapabilities,
  WalletInputError,
  type WalletPassArtifact,
  type WalletPassIssueInput,
  type WalletPassProvider,
  type WalletPassRevokeInput,
  type WalletPassUpdateInput,
  WalletRequestError,
} from "./provider.js";

const PROVIDER = "google";
const SAVE_LINK_PREFIX = "https://pay.google.com/gp/v/save/";
const WALLET_OBJECTS_BASE =
  "https://walletobjects.googleapis.com/walletobjects/v1";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUER_SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Domain separation for the object-id derivation below. */
const OBJECT_ID_PURPOSE = "opensesame:wallet:google:generic-object:v1";

/**
 * A ceiling on the save link, because a save link is a URL.
 *
 * There is no specified maximum URL length; there are practical ones, and
 * browsers, proxies, chat clients, and QR renderers each give up somewhere. The
 * widely-safe figure is 4096, and a fully-populated Generic pass costs roughly
 * 1900 characters before any display rows, so this leaves generous room for a
 * real pass while still catching an unbounded caller — a hundred rows of audit
 * detail — at the call site, next to the data that caused it, rather than as an
 * unexplained failure on somebody's phone.
 */
const SAVE_URL_MAX_LENGTH = 4096;

/** Google caps `textModulesData` at ten entries; silent truncation loses rows. */
const MAX_DISPLAY_ROWS = 10;

/** The language tag recorded on every `LocalizedString`. */
const DEFAULT_LANGUAGE = "en-US";

/** Dark slate. Google renders the card's own text light over this. */
const CARD_BACKGROUND = "#1f2933";

/** Refresh the access token early so a call never races its own expiry. */
const TOKEN_SKEW_SECONDS = 60;

/**
 * The card title: what kind of question this pass is fronting.
 *
 * Safe to print. An `InteractionSummary` already discloses `kind` to anyone
 * holding the reference, precisely so a surface can say "someone is asking you
 * to approve a device" before the approver authenticates — so putting the same
 * word on the pass tells a finder nothing the reference did not already.
 */
const KIND_LABELS = {
  device_authorization: "Device approval",
  pairing: "Device pairing",
  claim: "Ownership claim",
  grant_claim: "Grant claim",
  authorization_request: "Authorization request",
  transaction_authorization: "Transaction approval",
  // `satisfies` rather than an annotation: it still fails the build when a new
  // `InteractionKind` arrives without a label, and it keeps the literal types
  // so the table cannot be indexed by anything but a real kind.
} satisfies Record<InteractionKind, string>;

export interface GoogleLocalizedString {
  defaultValue: { language: string; value: string };
}

export interface GoogleBarcode {
  type: "QR_CODE";
  value: string;
}

export interface GoogleTextModule {
  id: string;
  header: string;
  body: string;
}

export interface GoogleUriEntry {
  id: string;
  uri: string;
  description: string;
}

export interface GoogleTimeInterval {
  start: { date: string };
  end: { date: string };
}

/** Google's Generic pass object state machine, as far as we use it. */
export type GoogleObjectState = "ACTIVE" | "EXPIRED";

export interface GoogleGenericObject {
  id: string;
  classId: string;
  state: GoogleObjectState;
  cardTitle: GoogleLocalizedString;
  header: GoogleLocalizedString;
  subheader?: GoogleLocalizedString;
  barcode: GoogleBarcode;
  textModulesData?: GoogleTextModule[];
  linksModuleData: { uris: GoogleUriEntry[] };
  validTimeInterval: GoogleTimeInterval;
  hexBackgroundColor: string;
}

/** The class an object points at. Created once by an operator, not per pass. */
export interface GoogleGenericClass {
  id: string;
}

/**
 * The Google adapter's own surface.
 *
 * `updatePass` and `revokePass` are required here rather than optional, and
 * `updatePass` always yields an artifact. Holding this type is a compile-time
 * statement that revocation exists; holding the vendor-neutral
 * `WalletPassProvider` obliges a caller to ask `capabilities()` first, which is
 * exactly the difference between the two.
 */
export interface GoogleWalletProvider extends WalletPassProvider {
  updatePass(input: WalletPassUpdateInput): Promise<WalletPassArtifact>;
  revokePass(input: WalletPassRevokeInput): Promise<void>;
}

export interface GoogleWalletProviderOptions {
  config: GoogleWalletEnabled;
  /**
   * Injected so tests never reach the network and so a host can supply its own
   * egress-controlled client. Defaults to the platform `fetch`.
   */
  fetchImpl?: typeof fetch;
  /** Injected clock, so validity windows are assertable. */
  now?: () => Date;
}

function localized(value: string): GoogleLocalizedString {
  return { defaultValue: { language: DEFAULT_LANGUAGE, value } };
}

/**
 * The Google object id for an interaction.
 *
 * Derived rather than random, for two reasons. It makes issuance idempotent —
 * re-issuing after a crash addresses the same object instead of littering the
 * issuer account with orphans — and it means `updatePass` and `revokePass` can
 * find the pass from the reference alone, so no caller ever has to hold, store,
 * or supply a Google object id. Hashing rather than embedding the reference
 * gives one canonical, charset-legal spelling regardless of how the reference
 * was written, and discloses nothing new: Google already receives the whole
 * interaction URL inside the barcode.
 */
function objectIdFor(config: GoogleWalletEnabled, interactionRef: string) {
  const digest = createHash("sha256")
    .update(`${OBJECT_ID_PURPOSE}\0${config.issuerId}\0${interactionRef}`)
    .digest("base64url")
    .slice(0, 32);
  return `${config.issuerId}.${digest}`;
}

/**
 * Require the barcode target to be one of ours.
 *
 * Without this, `issuePass` is a service that signs a Google-trusted pass
 * pointing at any URL the caller names — a phishing primitive wearing our
 * issuer's branding. The origin must match the configured public base URL.
 */
function assertInteractionUrl(
  config: GoogleWalletEnabled,
  raw: string,
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WalletInputError("interactionUrl is not an absolute URL.");
  }
  if (url.protocol !== "https:") {
    throw new WalletInputError("interactionUrl must use https.");
  }
  const base = new URL(config.publicBaseUrl);
  if (url.origin !== base.origin) {
    throw new WalletInputError(
      `interactionUrl origin "${url.origin}" is not the configured wallet origin "${base.origin}".`,
    );
  }
  return url.toString();
}

function assertIssueInput(
  config: GoogleWalletEnabled,
  input: WalletPassIssueInput,
  now: Date,
): string {
  if (input.interactionRef.trim().length === 0) {
    throw new WalletInputError("interactionRef must not be empty.");
  }
  if (input.title.trim().length === 0) {
    throw new WalletInputError("title must not be empty.");
  }
  if (Number.isNaN(input.expiresAt.getTime())) {
    throw new WalletInputError("expiresAt is not a date.");
  }
  if (input.expiresAt.getTime() <= now.getTime()) {
    // An already-lapsed pass is never the intent, and Google would happily
    // store it: the human would save a card that is dead the moment it lands.
    throw new WalletInputError("expiresAt is already in the past.");
  }
  const rows = input.displayRows ?? [];
  if (rows.length > MAX_DISPLAY_ROWS) {
    throw new WalletInputError(
      `displayRows holds ${rows.length} rows; Google renders at most ${MAX_DISPLAY_ROWS}.`,
    );
  }
  for (const row of rows) {
    if (row.label.trim().length === 0 || row.value.trim().length === 0) {
      throw new WalletInputError("displayRows entries must not be empty.");
    }
  }
  // A display row is a field name and a field value wearing different clothes.
  // Google stores the label as *data* (`textModulesData[].header`), so the
  // whole-payload walk would only ever see it as the value of a key called
  // `header` and would never apply the field-name rules to it — yet a row
  // labelled "Access token" is exactly the thing those rules exist to catch.
  // Checking each row as a one-key object restores that reading.
  //
  // It also makes a label into something a refusal message may quote, and a
  // label is free-form UI text rather than an identifier a programmer chose —
  // so `payload.ts` sanitizes every name it prints (see `displayName` there),
  // and a label carrying a newline or a misplaced secret is elided rather than
  // interpolated into a log line.
  assertPassPayloadSafe(rows.map((row) => ({ [row.label]: row.value })));
  return assertInteractionUrl(config, input.interactionUrl);
}

/**
 * The class an operator creates once, before any object may reference it.
 *
 * Exported because that step is otherwise a console click nobody records, and
 * a class id that does not exist yields the same opaque save-link failure as a
 * misconfigured issuer.
 */
export function buildGenericClass(
  config: GoogleWalletEnabled,
): GoogleGenericClass {
  return { id: config.classId };
}

/** The Generic pass object, exactly as it is signed into the save link. */
export function buildGenericObject(
  config: GoogleWalletEnabled,
  input: WalletPassIssueInput,
  now: Date,
  state: GoogleObjectState,
): GoogleGenericObject {
  const interactionUrl = assertIssueInput(config, input, now);
  const object: GoogleGenericObject = {
    id: objectIdFor(config, input.interactionRef),
    classId: config.classId,
    state,
    cardTitle: localized(KIND_LABELS[input.kind]),
    header: localized(input.title),
    barcode: { type: "QR_CODE", value: interactionUrl },
    linksModuleData: {
      uris: [
        {
          id: "interaction",
          uri: interactionUrl,
          description: "Open this request",
        },
      ],
    },
    validTimeInterval: {
      start: { date: now.toISOString() },
      end: { date: input.expiresAt.toISOString() },
    },
    hexBackgroundColor: CARD_BACKGROUND,
  };
  // Assigned rather than spread so an absent subtitle is an absent property,
  // not a property holding `undefined` — `exactOptionalPropertyTypes` and
  // Google's schema validator both care about the difference.
  if (input.subtitle !== undefined && input.subtitle.trim().length > 0) {
    object.subheader = localized(input.subtitle);
  }
  const rows = input.displayRows ?? [];
  if (rows.length > 0) {
    object.textModulesData = rows.map((row, index) => ({
      id: `row_${index}`,
      header: row.label,
      body: row.value,
    }));
  }
  return object;
}

/**
 * Create a Google Wallet provider bound to one issuer configuration.
 *
 * The signing key is imported lazily and once: importing eagerly would make
 * constructing a provider an async, fallible act at startup, and importing per
 * call would repeat an ASN.1 parse for every pass.
 */
export function createGoogleWalletProvider(
  options: GoogleWalletProviderOptions,
): GoogleWalletProvider {
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

  /**
   * PATCH one Generic object.
   *
   * Every status other than 2xx becomes a `WalletRequestError`. Google's own
   * error body is deliberately not quoted into the message: it is untrusted
   * remote content on its way into our logs, and the status plus the operation
   * is what an operator can act on anyway.
   */
  const patchObject = async (
    passId: string,
    body: Partial<GoogleGenericObject>,
  ): Promise<void> => {
    // The gate runs on outbound mutations too, not just on issuance: an update
    // is another way for a field to reach Google's servers.
    // `overlapCast` bridges the named interface to the boundary union the gate
    // takes: a structural interface has no index signature, and the gate must
    // not be narrowed to the shape it is checking.
    assertPassPayloadSafe(overlapCast(body));
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

  const issue = async (
    input: WalletPassIssueInput,
    state: GoogleObjectState,
  ): Promise<WalletPassArtifact> => {
    const issuedAt = now();
    const genericObject = buildGenericObject(config, input, issuedAt, state);

    const claims = {
      iss: config.serviceAccountEmail,
      aud: "google",
      typ: "savetowallet",
      iat: Math.floor(issuedAt.getTime() / 1000),
      origins: [...config.origins],
      payload: { genericObjects: [genericObject] },
    };
    // The gate runs over the whole claim set rather than the object alone, so
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

    return {
      provider: PROVIDER,
      saveUrl,
      passId: genericObject.id,
      expiresAt: input.expiresAt,
    };
  };

  return {
    capabilities(): WalletCapabilities {
      // No I/O. `issue` is pure signing and stays true through any Google
      // outage; `update` and `revoke` are the only capabilities that need a
      // client, so they are the only ones a missing `fetch` can take away.
      const hasFetch = fetchImpl !== undefined;
      return {
        provider: PROVIDER,
        available: true,
        issue: true,
        update: hasFetch,
        revoke: hasFetch,
        rotatingBarcode: false,
      };
    },

    issuePass(input: WalletPassIssueInput): Promise<WalletPassArtifact> {
      return issue(input, "ACTIVE");
    },

    async updatePass(
      input: WalletPassUpdateInput,
    ): Promise<WalletPassArtifact> {
      const state = input.state === "expired" ? "EXPIRED" : "ACTIVE";
      const genericObject = buildGenericObject(config, input, now(), state);
      await patchObject(genericObject.id, genericObject);
      // A fresh save link is returned as well: the link embeds the object, so
      // anyone who has not yet saved the pass should be handed the new one
      // rather than a link that would install the superseded content.
      return issue(input, state);
    },

    async revokePass(input: WalletPassRevokeInput): Promise<void> {
      // `EXPIRED` rather than a delete. Google offers no way to remove an
      // object from a device that already holds it, so expiry is the strongest
      // truthful statement available: the card greys out, stops being offered
      // for redemption, and the object survives for the audit trail.
      await patchObject(objectIdFor(config, input.interactionRef), {
        state: "EXPIRED",
      });
    },
  };
}
