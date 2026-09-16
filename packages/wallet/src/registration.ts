/**
 * The persistent launcher pass, and the wall between what a human's phone sees
 * and what only Google's servers see (ADR 0086).
 *
 * A per-interaction "address" pass (`google.ts`) fronts one question and lapses
 * with it. A **launcher** pass is the opposite: one durable card a person keeps
 * on their lock screen that opens OpenSesame — it is registered once, carries
 * no interaction, and never expires on its own. The two are separate *modes*
 * with separate builders on purpose, because the mistake this file exists to
 * prevent is treating them as one thing and letting a launcher inherit an
 * interaction's lifecycle, or an interaction inherit a launcher's rotating
 * barcode.
 *
 * ## Public vs provisioning
 *
 * The launcher object exists in two shapes, and the type system keeps them
 * apart because a runtime check alone would be one forgotten call away from a
 * disaster:
 *
 * - **`GoogleLauncherPublicObject`** is what goes inside the Save-to-Wallet
 *   JWT. That JWT lives in a URL, in a QR code, in a browser history, in a chat
 *   message — it is public, permanently. So the public object carries a
 *   *static* barcode (the launcher URL, which authorizes nothing) and nothing
 *   else. It has no field in which a secret could sit, by construction.
 * - **`GoogleLauncherProvisioningObject`** is what is PATCHed/POSTed to
 *   `walletobjects.googleapis.com` over an authenticated channel. It, and only
 *   it, may carry a `rotatingBarcode` whose `totpDetails.parameters[].key` is a
 *   real shared TOTP seed.
 *
 * **A rotating-barcode seed must never appear in a Save JWT.** Google's
 * rotating barcode is provisioned server-side; the seed is a secret held by a
 * third party. Putting it in the JWT would publish it. `assertLauncherPublicSafe`
 * is the runtime backstop for the type-level separation: it refuses any public
 * object that has grown a rotating-barcode or TOTP field before it is ever
 * signed.
 */

import { createHash } from "node:crypto";
import {
  type BoundaryValue,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import type { GoogleWalletEnabled } from "./config.js";
import type {
  GoogleBarcode,
  GoogleLocalizedString,
  GoogleObjectState,
  GoogleUriEntry,
} from "./google.js";
import { assertPassPayloadSafe } from "./payload.js";
import { WalletInputError } from "./provider.js";

/** The language tag recorded on every `LocalizedString`. */
const DEFAULT_LANGUAGE = "en-US";

/** Slate, a shade off the interaction card so the two read as different things. */
const LAUNCHER_BACKGROUND = "#111827";

/** Domain separation for the launcher object-id derivation. */
const LAUNCHER_OBJECT_PURPOSE = "opensesame:wallet:google:launcher-object:v1";

/**
 * The path a launcher barcode resolves to.
 *
 * Deliberately not `/i/` (an interaction reference): a launcher opens the app,
 * it does not front a single question. The control-plane hosts the landing
 * page for this path; here it is only used to build and validate the URL.
 */
const LAUNCHER_PATH = "w";

/** What the card says it is. A launcher is the app, not a question. */
const LAUNCHER_CARD_TITLE = "OpenSesame";

/** Card title on the pass. Never rendered from a kind. */
function localized(value: string): GoogleLocalizedString {
  return { defaultValue: { language: DEFAULT_LANGUAGE, value } };
}

/** A registration id may only be the charset a URL path and object id share. */
const REGISTRATION_ID = /^[A-Za-z0-9._-]{1,128}$/u;

/**
 * A rotating-barcode TOTP seed.
 *
 * This is the one secret in the whole launcher story. It is generated for a
 * registration, provisioned to Google over the authenticated REST channel, and
 * — critically — never stored in the clear and never signed into a Save JWT.
 * The type is named so a reader who sees it in a signature knows they are
 * holding the thing that must not leak.
 */
export interface RotatingBarcodeSeed {
  /** The shared secret, base32 (RFC 4648, no padding). */
  readonly key: string;
  /** Digits in the generated code Google renders. */
  readonly valueLength: number;
}

export interface GoogleTotpParameter {
  key: string;
  valueLength: number;
}

export interface GoogleTotpDetails {
  algorithm: "TOTP_SHA1";
  periodMillis: string;
  parameters: readonly GoogleTotpParameter[];
}

/**
 * Google's rotating barcode. Present only on the provisioning object.
 *
 * `valuePattern` embeds `{totp}`, the substitution Google fills with the
 * current code. The value it produces still authorizes nothing on our side —
 * the launcher URL is a launcher, not a bearer — so rotation buys availability
 * theatre rather than security (see `google.ts`); it is supported here solely
 * because a deployment may want it and because the seed's handling is the part
 * that actually matters.
 */
export interface GoogleRotatingBarcode {
  type: "TOTP";
  renderEncoding: "UTF_8";
  valuePattern: string;
  totpDetails: GoogleTotpDetails;
  alternateText?: string;
}

/**
 * The launcher object as it is signed into the Save JWT.
 *
 * No `validTimeInterval`: a launcher is persistent, and an omitted interval is
 * how Google is told a Generic object does not expire. No `rotatingBarcode`:
 * there is no field here in which a seed could ride.
 */
export interface GoogleLauncherPublicObject {
  id: string;
  classId: string;
  state: GoogleObjectState;
  cardTitle: GoogleLocalizedString;
  header: GoogleLocalizedString;
  subheader?: GoogleLocalizedString;
  barcode: GoogleBarcode;
  linksModuleData: { uris: GoogleUriEntry[] };
  hexBackgroundColor: string;
}

/**
 * The launcher object as provisioned to Google over the authenticated channel.
 *
 * Extends the public object with the one field that may hold a secret. A caller
 * that has a `GoogleLauncherProvisioningObject` must send it through the REST
 * client, never through `signSaveUrl`; the type does not stop that, but
 * `assertLauncherPublicSafe` does.
 */
export interface GoogleLauncherProvisioningObject
  extends GoogleLauncherPublicObject {
  rotatingBarcode?: GoogleRotatingBarcode;
}

/** What a caller supplies to mint a launcher, and nothing more. */
export interface WalletLauncherInput {
  /** Stable, caller-chosen id for this device registration. */
  registrationId: string;
  /** The card's second line, e.g. a device label. Non-secret display text. */
  header: string;
  subtitle?: string;
}

/** A launcher input that cannot be turned into a pass. */
export class WalletLauncherError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "WalletLauncherError";
  }
}

function assertRegistrationId(registrationId: string): string {
  const trimmed = registrationId.trim();
  if (!REGISTRATION_ID.test(trimmed)) {
    throw new WalletLauncherError(
      "registrationId must be 1–128 characters of letters, digits, '.', '_' or '-'.",
    );
  }
  return trimmed;
}

/**
 * The canonical launcher URL for a registration.
 *
 * Built against the configured public base URL so the barcode can only ever
 * point at this deployment's own origin — the same guarantee `google.ts` gives
 * an interaction barcode, for the same reason: a pass that resolved elsewhere
 * would be a phishing primitive wearing the issuer's branding.
 */
export function launcherUrl(
  config: GoogleWalletEnabled,
  registrationId: string,
): string {
  const id = assertRegistrationId(registrationId);
  const url = new URL(
    `/${LAUNCHER_PATH}/${encodeURIComponent(id)}`,
    config.publicBaseUrl,
  );
  return url.toString();
}

/**
 * The Google object id for a launcher registration.
 *
 * Derived rather than random so provisioning is idempotent and so disablement
 * can address the object from the registration id alone, with no id to store.
 */
export function launcherObjectId(
  config: GoogleWalletEnabled,
  registrationId: string,
): string {
  // Reuse the interaction adapter's hashing shape by importing its helper would
  // couple the two modes; a launcher's derivation is its own on purpose.
  const id = assertRegistrationId(registrationId);
  // Kept local rather than shared with google.ts so the two id spaces cannot
  // collide by construction — a launcher id carries the `l_` marker and its own
  // purpose string.
  const digest = createHash("sha256")
    .update(`${LAUNCHER_OBJECT_PURPOSE}\0${config.issuerId}\0${id}`)
    .digest("base64url")
    .slice(0, 32);
  return `${config.issuerId}.l_${digest}`;
}

function baseObject(
  config: GoogleWalletEnabled,
  input: WalletLauncherInput,
  state: GoogleObjectState,
): GoogleLauncherPublicObject {
  if (input.header.trim().length === 0) {
    throw new WalletLauncherError("header must not be empty.");
  }
  const url = launcherUrl(config, input.registrationId);
  const object: GoogleLauncherPublicObject = {
    id: launcherObjectId(config, input.registrationId),
    classId: config.classId,
    state,
    cardTitle: localized(LAUNCHER_CARD_TITLE),
    header: localized(input.header),
    // Static barcode: the launcher URL, which authorizes nothing. A rotating
    // barcode never appears on the public object.
    barcode: { type: "QR_CODE", value: url },
    linksModuleData: {
      uris: [{ id: "launcher", uri: url, description: "Open OpenSesame" }],
    },
    hexBackgroundColor: LAUNCHER_BACKGROUND,
  };
  if (input.subtitle !== undefined && input.subtitle.trim().length > 0) {
    object.subheader = localized(input.subtitle);
  }
  return object;
}

/**
 * The launcher object for the Save JWT. Screened before it is ever returned.
 *
 * `assertLauncherPublicSafe` runs here so the object handed to the signer is
 * already known to carry no seed and no forbidden material — the caller cannot
 * skip it.
 */
export function buildLauncherPublicObject(
  config: GoogleWalletEnabled,
  input: WalletLauncherInput,
  state: GoogleObjectState = "ACTIVE",
): GoogleLauncherPublicObject {
  const object = baseObject(config, input, state);
  assertLauncherPublicSafe(object);
  return object;
}

/**
 * The launcher object for the REST channel, optionally carrying a rotating
 * barcode seed.
 *
 * The seed lives here and only here. When one is supplied the object grows a
 * `rotatingBarcode.totpDetails.parameters[].key`; this object must be sent to
 * `patchGenericObject`/`insertGenericObject`, never to `signSaveUrl`.
 */
export function buildLauncherProvisioningObject(
  config: GoogleWalletEnabled,
  input: WalletLauncherInput,
  seed?: RotatingBarcodeSeed,
  state: GoogleObjectState = "ACTIVE",
): GoogleLauncherProvisioningObject {
  const base = baseObject(config, input, state);
  if (seed === undefined) return base;
  if (seed.key.trim().length === 0) {
    throw new WalletLauncherError("a rotating barcode seed must not be empty.");
  }
  return {
    ...base,
    rotatingBarcode: {
      type: "TOTP",
      renderEncoding: "UTF_8",
      // The rotating value is the launcher URL with the current code appended
      // as an opaque, non-authorizing nonce. It resolves to the same launcher.
      valuePattern: `${base.barcode.value}#{totp}`,
      totpDetails: {
        algorithm: "TOTP_SHA1",
        periodMillis: "30000",
        parameters: [{ key: seed.key, valueLength: seed.valueLength }],
      },
    },
  };
}

/** Normalized field name, matching the payload gate's spelling-fold. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

/** Field names that mean a seed is present and so may never reach a JWT. */
const SEED_BEARING_NAMES: ReadonlySet<string> = new Set([
  "rotatingbarcode",
  "totpdetails",
  "totp",
  "seed",
]);

/**
 * Refuse any launcher object bound for a Save JWT that carries a rotating
 * barcode or a TOTP seed, then apply the full payload gate.
 *
 * This is the runtime half of the public/provisioning split. The type system
 * says a `GoogleLauncherPublicObject` has no `rotatingBarcode`; this says the
 * *bytes* about to be signed have none either, so a widening cast or a stray
 * spread cannot put a seed on the wire. It walks the emitted JSON, not the live
 * object, for the same reason `payload.ts` does — the serializer's output is
 * what gets signed.
 */
export function assertLauncherPublicSafe(
  object: GoogleLauncherPublicObject,
): void {
  const emitted = JSON.stringify(object);
  const scanned: BoundaryValue = JSON.parse(emitted);
  const stack: BoundaryValue[] = [scanned];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (!isJsonObject(node)) continue;
    for (const [childKey, childValue] of Object.entries(node)) {
      if (SEED_BEARING_NAMES.has(normalize(childKey))) {
        throw new WalletLauncherError(
          `a launcher object bound for a Save JWT carries "${childKey}"; a rotating-barcode seed must never be signed into a save link`,
        );
      }
      stack.push(childValue);
    }
  }
  // Everything the interaction pass is screened for applies here too.
  assertPassPayloadSafe(overlapCast(object));
}
