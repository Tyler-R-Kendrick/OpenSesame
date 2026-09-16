/**
 * The request-binding transaction-data entry, read back (finding F08).
 *
 * Building the entry lives in `request.ts`; reading it lives here, one file per
 * direction. By the time {@link assertApprovalBinding} runs, `verifyTransaction
 * Data` in `verify.ts` has already proved the holder's key-binding signature
 * covers a hash of *every* authorized entry's exact encoded bytes — including
 * this binding entry's. So decoding the binding entry and finding the expected
 * digests inside it upgrades the cheap request-session cross-check into "the
 * holder signed a statement naming this request and this approval".
 *
 * Two digests are checked, and the second is the one F08 adds:
 *
 * - `request_digest` — the **protocol** digest. Kept as a defence-in-depth tie
 *   to the wire request, and because a wallet that echoes it proves it read the
 *   entry this verifier built rather than one an attacker substituted.
 * - `approval_binding_digest` — the **approval** digest. This is the value
 *   `VerifiedPresentation.boundDigest` returns, and therefore the value ADR
 *   0086's `approve()` compares against the interaction's own digest. Binding a
 *   protocol-internal digest here instead — the pre-F08 behaviour — meant the
 *   holder's signature could never satisfy that comparison, so the whole
 *   verifiable-presentation approval path was decorative.
 *
 * Both comparisons are constant time and both raise the same `digest_mismatch`
 * at the same `request_binding` checkpoint: a wallet that echoed the wrong
 * value learns only that the binding did not match, not which of the two.
 */

import { type JsonValue, isJsonObject, isString } from "@opensesame/os-domain";
import { constantTimeEquals, decodeBase64url, decodeUtf8 } from "./encoding.js";
import { guarded, refuse } from "./errors.js";
import {
  type AuthorizationRequest,
  REQUEST_BINDING_TRANSACTION_DATA_TYPE,
} from "./request.js";

/**
 * Confirm the digests the holder signed over are this request's digests.
 *
 * Refuses when the binding entry is missing, unparseable, or carries a digest
 * that is not a string or not the expected value. The parse runs inside
 * `guarded` so a malformed entry lands on `digest_mismatch` rather than leaking
 * a `SyntaxError` — see `errors.ts` for why a foreign error crossing this
 * boundary is a defect in its own right.
 */
export function assertApprovalBinding(request: AuthorizationRequest): void {
  const binding = request.transactionData.find(
    (entry) => entry.type === REQUEST_BINDING_TRANSACTION_DATA_TYPE,
  );
  if (binding === undefined) refuse("digest_mismatch", "request_binding");
  const decoded = guarded("request_binding", "digest_mismatch", () => {
    const parsed: JsonValue = JSON.parse(
      decodeUtf8(decodeBase64url(binding.encoded)),
    );
    if (!isJsonObject(parsed)) throw new SyntaxError("not an object");
    return parsed;
  });
  const protocol = decoded.request_digest;
  if (
    !isString(protocol) ||
    !constantTimeEquals(protocol, request.digests.protocol)
  ) {
    refuse("digest_mismatch", "request_binding");
  }
  const approval = decoded.approval_binding_digest;
  if (
    !isString(approval) ||
    !constantTimeEquals(approval, request.digests.approval)
  ) {
    refuse("digest_mismatch", "request_binding");
  }
}
