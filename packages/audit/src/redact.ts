import {
  type JsonObject,
  isBoolean,
  isNumber,
  isString,
} from "@opensesame/os-domain";
/**
 * Allowlisted metadata keys that may appear in audit events.
 * Anything else is dropped; secrets matching deny patterns are stripped.
 */
export const AUDIT_METADATA_ALLOWLIST = new Set([
  "reason",
  "action",
  // Recorded at the call sites and previously dropped on the way in: an
  // identity-link event that does not say which issuer and subject kind granted
  // the assurance is the one event a reviewer most needs to read.
  "kind",
  "issuer",
  "tenant",
  // How the subject came to be linked or minted — "id_token" for an assertion
  // an upstream vouched for, "interaction_login" for a principal minted at the
  // hosted login page. Both call sites already set it and both were dropping
  // it here, so the trail recorded that an identity was linked without
  // recording what authorised it. That provenance is the difference between a
  // verified admission and a self-asserted one.
  "via",
  "slug",
  "note",
  "sectorIdentifier",
  "admissionMode",
  "previousClientId",
  "resourceType",
  "resourceId",
  "projectId",
  "organizationId",
  "claimId",
  "agentId",
  "state",
  "fromState",
  "toState",
  "outcome",
  "idempotencyKey",
  "ttlSeconds",
  "quotaProfile",
  "path",
  "method",
  "statusCode",
  "won",
  "count",
  "type",
  // Secret/config changelog (metadata only — never values).
  "configId",
  "environment",
  "keyNames",
  "versionId",
  "targetId",
  "contentVersion",
  "actor",
  // Authorization inbox + delegation (ADR 0044/0046). Every one of these is an
  // id or a digest: DENY_KEY runs before this allowlist, so a key named for the
  // thing it identifies (userCode, bindingToken) would be dropped silently and
  // the one event a reviewer needs would arrive blank.
  "authReqId",
  "approvalId",
  "requestDigest",
  "bindingMessageDigest",
  "decidedByKind",
  "connectionId",
  "delegationId",
  "offerId",
  "invocationId",
  // Derived materialization (ADR 0049): the RFC 8693 mapping and the policy
  // that permitted the mint. Ids and policy names only — DENY_KEY still drops
  // anything named like the token itself.
  "subject",
  "providerId",
  "materialization",
  // External notification channels and approval ceremonies (ADR 0084). Every
  // one of these is an id, a digest, a closed enum member, or a reason code —
  // the vocabulary a reviewer needs to answer "why was this allowed, and could
  // a compromised chat workspace have caused it?" years later.
  //
  // Two names are deliberately absent. The comparison value would be dropped
  // by DENY_KEY anyway (it contains "value"), and that is the belt to this
  // brace rather than the reason: a plaintext comparison code has no business
  // in an audit row, so no call site builds a key for it. Likewise the
  // provider subject id never appears — it is the authority-bearing half of a
  // binding, and an audit trail that prints it hands a forger the value a
  // fake callback would need to claim. Its digest goes here instead.
  "channelKind",
  "bindingId",
  "transactionDigest",
  "policyDigest",
  "activationId",
  "approvalPath",
  "riskClass",
  // Reason-code arrays from the assurance evaluator, so the bar that was
  // demanded and the bar that was met are both legible without re-deriving
  // them from a policy that has since changed.
  "requiredAssurance",
  "achievedAssurance",
  "refusals",
  "comparisonRequired",
  "comparisonSatisfied",
  "callbackDigest",
  "providerTenantDigest",
  "providerSubjectDigest",
  "notificationClass",
  "deliveryId",
  "detailsDigest",
  "receiptVersion",
  // Cross-device interactions (ADR 0086). `interactionId` is the stored id and
  // never the public reference: a reference is what a stranger holding a
  // photographed QR has, and an audit row is not the place to hand a reader
  // one. `mechanism` records how an approval was proven — recorded, never
  // inferred from the session. `walletProvider`/`passId` identify a pass
  // without describing it, and `assurance` is the level cleared, not the
  // evidence that cleared it.
  "interactionId",
  "interactionKind",
  "subjectKind",
  "subjectId",
  "mechanism",
  "credentialRef",
  "assurance",
  "walletProvider",
  "passId",
  "presentationId",
]);

/**
 * Keys that must never appear in audit metadata.
 * Matches `value`, `secret`, `password`, `token` (and related) case-insensitively.
 */
const DENY_KEY =
  /value|token|secret|password|authorization|cookie|code_verifier|user.?code|device.?code|refresh|bearer/i;

/**
 * The deny pass, exported so the boundary is directly testable: a key that
 * names the secret it identifies never reaches an audit row, allowlisted or
 * not.
 */
export function isDeniedAuditMetadataKey(key: string): boolean {
  return DENY_KEY.test(key);
}

function truncateString(value: string): string {
  return value.length > AUDIT_VALUE_MAX_LENGTH
    ? `${value.slice(0, AUDIT_VALUE_MAX_LENGTH)}…`
    : value;
}

/**
 * Longest string an audit value may carry.
 *
 * Several allowlisted values (issuer, slug, sector identifier) come from the
 * request, and an audit store that accepts whatever length a caller sends grows
 * for as long as they keep sending. Truncate rather than drop: a shortened
 * issuer still tells a reviewer what happened.
 */
export const AUDIT_VALUE_MAX_LENGTH = 256;

export function redactAuditMetadata(
  metadata: JsonObject | undefined,
): JsonObject {
  if (!metadata) return {};
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(metadata)) {
    // Stryker disable next-line ConditionalExpression: this layer is
    // deliberately redundant with the allowlist below — every key it catches
    // is already absent from the allowlist, so removing the check changes no
    // observable behaviour and no test can kill the mutant. It is kept as the
    // layer that still holds if a secret-shaped key is added to the allowlist
    // by mistake; that intent is pinned by testing isDeniedAuditMetadataKey.
    if (isDeniedAuditMetadataKey(key)) continue;
    if (!AUDIT_METADATA_ALLOWLIST.has(key)) continue;
    if (isString(value)) {
      out[key] = truncateString(value);
    } else if (isNumber(value) || isBoolean(value)) {
      out[key] = value;
    } else if (value === null) {
      out[key] = null;
    } else if (
      Array.isArray(value) &&
      value.every((entry) => isString(entry))
    ) {
      // keyNames (and similar) — names only, still length-bounded.
      out[key] = value.map((entry) => truncateString(entry));
    }
  }
  return out;
}
