import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import {
  assertionPayload,
  isPublicKeyCredential,
  parsePublicKeyCredentialRequestOptionsJson,
  requestOptionsFromJson,
} from "@opensesame/sdk-browser";

/**
 * The Identity API origin and the two step-ups this phone can actually perform.
 *
 * Split out of the screens because both the approval surface and the enrolment
 * surface need a passkey assertion, and a second copy of that ceremony is a
 * second place for the "did the authenticator really answer?" checks to drift.
 * ADR 0086 §7 is the reason the return value is so thin: an assertion is a
 * verification *input*, checked once at the protocol edge and dropped, and what
 * survives into an `ApprovalProof` is a non-secret credential handle and
 * nothing else.
 */

/**
 * One origin, trailing slashes removed once.
 *
 * Read at module load rather than per call: `import.meta.env` is inlined at
 * build time, so a runtime read would only add the illusion that this is
 * reconfigurable.
 */
export const identityBase = (
  import.meta.env.VITE_IDENTITY_API ?? "http://127.0.0.1:8788"
).replace(/\/+$/, "");

/** A JSON body, or `null` for anything that is not a JSON object. */
export async function responseObject(
  response: Response,
): Promise<JsonObject | null> {
  const value: BoundaryValue = await response.json().catch(() => null);
  return isJsonObject(value) ? value : null;
}

export function stringField(
  body: JsonObject | null,
  key: string,
): string | undefined {
  return readString(body?.[key]);
}

/**
 * Exactly the two headers an authenticated MFA call carries.
 *
 * Named rather than left as an open string map, so the contract is the header
 * set itself: a JSON body and one bearer. An open dictionary here would make
 * every caller free to bolt a third header onto a request that carries the
 * human's session token, and nothing in the type would notice.
 */
type BearerJsonHeaders = {
  "content-type": "application/json";
  authorization: `Bearer ${string}`;
};

/** Bearer headers for the authenticated MFA routes. */
export function jsonHeaders(token: string): BearerJsonHeaders {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

/**
 * A step-up that did not produce a proof.
 *
 * Distinct from `InteractionError` on purpose: that one reports what the
 * interaction endpoint said about a *decision*, this one reports that the
 * human never got as far as making one. Nothing that throws this has put an
 * approval on the wire, and the screens rely on that to stay silent about
 * outcomes rather than guessing at a partial one.
 */
export class StepUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepUpError";
  }
}

/** True when this browser can even attempt a platform authenticator. */
export function hasWebAuthn(): boolean {
  // Read as a property of `globalThis` rather than as the bare `window`
  // binding, whose absence a plain reference cannot survive: this module is
  // also loaded where no DOM exists, and the optional chain answers "no"
  // there rather than raising a ReferenceError.
  return Boolean(globalThis.window?.PublicKeyCredential);
}

/**
 * Assert an existing passkey, returning the credential handle.
 *
 * The assert call carries no bearer, matching the endpoint it talks to: the
 * Identity API fences `/v1/mfa/passkey/assert` with anonymous rate budgets and
 * a per-credential failure fence rather than a session, because an assertion
 * is how a caller *becomes* authenticated. The options call before it is the
 * authenticated half, so it does carry one.
 *
 * Throws `StepUpError` for every failure, including cancellation: from the
 * caller's side "the user dismissed the sheet" and "the server rejected the
 * signature" are the same fact — there is no proof — and letting them diverge
 * is how a screen ends up reporting progress it does not have.
 */
export async function assertPasskey(token: string): Promise<string> {
  const optionsRes = await fetch(
    `${identityBase}/v1/mfa/passkey/authentication-options`,
    { method: "POST", headers: jsonHeaders(token) },
  );
  const optionsBody = await responseObject(optionsRes);
  const options = parsePublicKeyCredentialRequestOptionsJson(
    optionsBody?.options,
  );
  if (!optionsRes.ok || !options) {
    throw new StepUpError(
      stringField(optionsBody, "hint") ??
        stringField(optionsBody, "error") ??
        `Passkey options failed (${optionsRes.status})`,
    );
  }
  const assertion = await navigator.credentials.get(
    requestOptionsFromJson(options),
  );
  if (!assertion) throw new StepUpError("Passkey cancelled.");
  if (!isPublicKeyCredential(assertion)) {
    throw new StepUpError("Passkey returned an invalid credential.");
  }
  const res = await fetch(`${identityBase}/v1/mfa/passkey/assert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(assertionPayload(assertion)),
  });
  if (!res.ok) throw new StepUpError("Passkey rejected.");
  // The credential id, not the assertion. Non-secret, and the only part of a
  // WebAuthn response that is safe to carry in an audit row (ADR 0086 §7).
  return assertion.id;
}

/**
 * Re-verify a TOTP code.
 *
 * The fallback rung of the approval ladder, and a real round trip rather than
 * a locally minted claim: ADR 0086 §7 is explicit that an authenticated
 * session is not an approval, so the weaker mechanism still has to cost the
 * human a current code that the server checks.
 *
 * An empty code is *not* refused here. Whether a blank field is worth a round
 * trip is a screen's question — the approval surface disables its own control
 * instead, so the human never reaches a request that cannot succeed — and a
 * guard in here would only be a second, invisible copy of that rule.
 */
export async function verifyTotpCode(
  token: string,
  code: string,
): Promise<void> {
  const trimmed = code.trim();
  const res = await fetch(`${identityBase}/v1/mfa/totp/verify`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ code: trimmed }),
  });
  const body = await responseObject(res);
  if (!res.ok || body?.ok !== true) throw new StepUpError("Code rejected.");
}
