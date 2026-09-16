/**
 * The DCQL the verifier will build, and the exact profile it supports (F09).
 *
 * OpenID4VP 1.0 §6 defines DCQL as a large surface: many Credential Queries in
 * one request, `credential_sets` with `required`/`options`, `multiple`,
 * `claim_sets`, `trusted_authorities`, and per-claim `values`. This package
 * implements a deliberately small, closed subset of it, and the interesting
 * question for anyone integrating is exactly where that line is. This file is
 * that line, stated once, as data.
 *
 * The subset is not an accident of what was easy. `VerifiedPresentation`
 * describes **one** trust conclusion, so one response must carry one
 * presentation, so the request must ask for exactly one credential. Everything
 * else in {@link DCQL_PROFILE}'s `notSupported` follows from that same
 * decision: `credential_sets`, `multiple:true` and several Credential Queries
 * each turn one response into several independent conclusions the return type
 * cannot represent, and a request is declined at construction rather than
 * reduced to something smaller than the caller wrote.
 *
 * `claim_sets` and per-claim `values` are absent for a different reason: this
 * verifier re-checks `format` and `meta.vct_values` against the returned
 * credential and nothing else, so accepting a request that asked for a claim
 * constraint it would not enforce would be a promise it does not keep. Callers
 * assert claim presence against `VerifiedPresentation.claims` themselves.
 */

import type { JsonObject, MutableJsonObject } from "@opensesame/os-domain";
import { refuse } from "./errors.js";

/**
 * Credential Format Identifiers this package recognizes by name.
 *
 * Recognizing is not supporting. `mso_mdoc` is listed so that a response
 * carrying one is refused as "a format we know and do not verify" rather than
 * falling through a default branch — see {@link VERIFIABLE_CREDENTIAL_FORMATS}.
 */
export const KNOWN_CREDENTIAL_FORMATS = [
  "dc+sd-jwt",
  "vc+sd-jwt",
  "mso_mdoc",
] as const;

export type CredentialFormat = (typeof KNOWN_CREDENTIAL_FORMATS)[number];

/**
 * Formats this verifier can actually check end to end.
 *
 * `mso_mdoc` is absent. Verifying one means CBOR, COSE_Sign1, an IssuerAuth
 * MSO, device authentication over a SessionTranscript whose construction
 * differs between redirect and DC API invocation (§B.2.6), and an X.509 IACA
 * trust chain — none of which is reachable from `jose`, and all of which would
 * be a second, unrelated credential stack in a package whose value is that its
 * verification path is short enough to read. Declaring it unsupported and
 * refusing it by name is honest; accepting it and checking only the parts that
 * happen to be easy would not be.
 */
export const VERIFIABLE_CREDENTIAL_FORMATS = [
  "dc+sd-jwt",
  "vc+sd-jwt",
] as const;

export type VerifiableCredentialFormat =
  (typeof VERIFIABLE_CREDENTIAL_FORMATS)[number];

export function isKnownCredentialFormat(
  value: string,
): value is CredentialFormat {
  return KNOWN_CREDENTIAL_FORMATS.some((candidate) => candidate === value);
}

export function isVerifiableCredentialFormat(
  value: string,
): value is VerifiableCredentialFormat {
  return VERIFIABLE_CREDENTIAL_FORMATS.some((candidate) => candidate === value);
}

/**
 * A claims path pointer (§7) — the DCQL way of naming a claim.
 *
 * `null` selects every element of an array; a number selects one index. Kept
 * as data rather than a dotted string because a dotted string cannot express
 * either without an escaping rule. Forwarded to the wallet and never re-matched
 * by this verifier — see {@link DCQL_PROFILE}.
 */
export interface DcqlClaimQuery {
  readonly path: readonly (string | number | null)[];
  readonly id?: string | undefined;
}

/**
 * One Credential Query (§6.1).
 *
 * `vctValues` is promoted out of the format-specific `meta` object and made
 * required because §B.3.5 makes `vct_values` REQUIRED for `dc+sd-jwt`, and it
 * is the only part of the query this verifier actually re-checks against the
 * returned credential.
 */
export interface DcqlCredentialQuery {
  readonly id: string;
  readonly format: VerifiableCredentialFormat;
  readonly vctValues: readonly string[];
  readonly claims?: readonly DcqlClaimQuery[] | undefined;
}

export interface DcqlQuery {
  readonly credentials: readonly DcqlCredentialQuery[];
}

/** `id` values are constrained by §6.1 to this alphabet. */
const DCQL_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The stable identifier of the DCQL profile this verifier implements.
 *
 * Versioned so a widening — a second Credential Query, `claim_sets` matching —
 * is a new profile id rather than a silent change to what a caller who cited
 * this string believed they were getting.
 */
export const DCQL_PROFILE_ID = "opensesame-openid4vp-dcql/1.0";

/**
 * The exact DCQL profile, as a machine-readable constant (finding F09).
 *
 * Quote this rather than paraphrase it. Like `SUPPORT_MATRIX`, its `not
 * Supported` list is the point: a profile that stated only what it accepts
 * would leave every integrator to discover the boundary by trial.
 */
export const DCQL_PROFILE = {
  id: DCQL_PROFILE_ID,
  specification: "OpenID for Verifiable Presentations 1.0 §6 (DCQL)",
  /** Exactly one Credential Query per request. Not "at least one". */
  credentialQueries: { minimum: 1, maximum: 1 },
  formats: VERIFIABLE_CREDENTIAL_FORMATS,
  /** Every field a query must carry, and the one this verifier re-checks. */
  required: [
    "credentials[].id — §6.1 alphabet [A-Za-z0-9_-], unique within the request",
    "credentials[].format — one of the profile's formats",
    "credentials[].meta.vct_values — a non-empty array; re-checked against the credential's vct",
  ],
  /** Accepted, forwarded to the wallet, and not re-matched by the verifier. */
  advisory: [
    "credentials[].claims — claims path pointers (§7); assert presence against VerifiedPresentation.claims",
  ],
  notSupported: [
    "more than one Credential Query (one response is one trust conclusion)",
    "credential_sets / required / options (§6.3)",
    "multiple:true (§6.1)",
    "claim_sets (§6.4)",
    "per-claim values matching (§6.4)",
    "trusted_authorities (§6.1.1)",
  ],
} as const;

/**
 * Enforce {@link DCQL_PROFILE} against a query, returning the query ids.
 *
 * The ids come back because the caller needs them twice more — to check that
 * every `transaction_data` entry names a credential the query actually asked
 * for, and to scope the appended request-binding entry — and computing the set
 * once here keeps the profile's alphabet and uniqueness rule in one place.
 *
 * Every refusal is a construction-time `malformed_presentation` /
 * `format_not_supported` at the `request_construction` checkpoint, because
 * nobody has been asked to approve anything yet: the caller who wrote the query
 * is the only party inconvenienced, which is where a profile violation belongs.
 */
export function assertDcqlProfile(query: DcqlQuery): ReadonlySet<string> {
  const credentials = query.credentials;
  if (credentials.length !== DCQL_PROFILE.credentialQueries.maximum) {
    refuse("malformed_presentation", "request_construction");
  }
  const ids = new Set<string>();
  for (const credential of credentials) {
    if (!DCQL_ID.test(credential.id) || ids.has(credential.id)) {
      refuse("malformed_presentation", "request_construction");
    }
    ids.add(credential.id);
    if (!isVerifiableCredentialFormat(credential.format)) {
      refuse("format_not_supported", "request_construction");
    }
    if (credential.vctValues.length === 0) {
      refuse("malformed_presentation", "request_construction");
    }
  }
  return ids;
}

/**
 * Project a {@link DcqlQuery} into the §6.1 JSON the wallet reads.
 *
 * `vct_values` goes back inside `meta`, where the wire format keeps it, and
 * claims path pointers are copied as-is.
 */
export function dcqlQueryToJson(query: DcqlQuery): JsonObject {
  return {
    credentials: query.credentials.map((credential) => {
      const entry: MutableJsonObject = {
        id: credential.id,
        format: credential.format,
        meta: { vct_values: [...credential.vctValues] },
      };
      if (credential.claims !== undefined) {
        entry.claims = credential.claims.map((claim) => {
          const claimEntry: MutableJsonObject = { path: [...claim.path] };
          if (claim.id !== undefined) claimEntry.id = claim.id;
          return claimEntry;
        });
      }
      return entry;
    }),
  };
}
