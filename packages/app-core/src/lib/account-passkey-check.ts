/**
 * One try of a passkey just added to the Identity account (ADR 0140 plan
 * step 11c, carried over from mobile-MFA before it was deleted).
 *
 * Registration succeeding says the service stored a public key; it does not
 * say this browser can use the credential. A passkey that registered but
 * cannot be asserted is found out at the worst moment — an approval with a
 * countdown — so `enrollAccountPasskey` asserts it once, the way a sign-in
 * will: the service's request options (`/v1/mfa/passkey/authentication-
 * options`, with the session), the browser's sheet through the one WebAuthn
 * assertion wrapper Pages has (`interactions.ts`), and the assertion to
 * `/v1/mfa/passkey/assert` with no bearer and no cookie. That route is
 * anonymous, and a refused assertion answers 401, which on the session plane
 * would end the session.
 *
 * The registration is never rolled back. A try that did not finish is still
 * a saved passkey, and the words say so, so nobody adds a second one.
 */

import { InteractionStepUpError } from "@opensesame/ceremony-kit";
import type { InteractionAssertion } from "@opensesame/ceremony-kit";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";

/**
 * Why a passkey the service saved was not tried to the end: the person
 * dismissed the sheet, the service refused the assertion, or the try could
 * not finish. The passkey stays registered in every case.
 */
export type PasskeyCheckMiss = "cancelled" | "assert_refused" | "assert_failed";

/** Each miss, as the person is told it: never "failed", never "add another". */
export const ACCOUNT_PASSKEY_UNCHECKED_WORDS = {
  cancelled:
    "Passkey added to your account. Its first try was dismissed, but it is saved: keep it rather than adding another.",
  assert_refused:
    "Passkey added to your account, but your sign-in service turned down its first try. Remove it here rather than adding another.",
  assert_failed:
    "Passkey added to your account. Its first try did not finish, but it is saved: keep it rather than adding another.",
} as const satisfies Record<PasskeyCheckMiss, string>;

/** How adding a passkey ended: tried and accepted, or saved but not tried. */
export type AccountPasskeyEnrolment =
  | { kind: "verified" }
  | { kind: "registered_unverified"; reason: PasskeyCheckMiss };

export interface PasskeyCheckTransport {
  /** A signed-in Identity API call; `path` is base-relative. */
  fetch(path: string, init: RequestInit): Promise<Response>;
  /** The same plane with no session and no cookie. */
  anonymous(path: string, init: RequestInit): Promise<Response>;
}

export interface PasskeyAsserter {
  /** Try a passkey over the service's request options; answer the assertion. */
  assert(options: JsonObject): Promise<InteractionAssertion>;
}

async function requestOptions(
  transport: PasskeyCheckTransport,
): Promise<JsonObject | null> {
  try {
    const res = await transport.fetch(
      "/v1/mfa/passkey/authentication-options",
      { method: "POST" },
    );
    if (!res.ok) return null;
    const body: BoundaryValue = overlapCast(await res.json());
    const options = isJsonObject(body) ? body.options : null;
    return isJsonObject(options) ? options : null;
  } catch {
    return null;
  }
}

/**
 * Assert the passkey once. Answers what kept the try short, or `null` when
 * the service accepted it; never throws, because the passkey is saved.
 */
export async function tryAccountPasskey(binding: {
  transport: PasskeyCheckTransport;
  authenticator: PasskeyAsserter;
}): Promise<PasskeyCheckMiss | null> {
  const options = await requestOptions(binding.transport);
  if (!options) return "assert_failed";
  let assertion: InteractionAssertion;
  try {
    assertion = await binding.authenticator.assert(options);
  } catch (error) {
    // A dismissed sheet and a timeout are one fact: there is no assertion.
    const dismissed =
      error instanceof InteractionStepUpError && error.reason === "cancelled";
    return dismissed ? "cancelled" : "assert_failed";
  }
  let res: Response;
  try {
    res = await binding.transport.anonymous("/v1/mfa/passkey/assert", {
      method: "POST",
      body: JSON.stringify(assertion),
    });
  } catch {
    return "assert_failed";
  }
  if (res.ok) return null;
  // A rate limit or a fault is a try that did not finish, not a verdict.
  return res.status === 429 || res.status >= 500
    ? "assert_failed"
    : "assert_refused";
}
