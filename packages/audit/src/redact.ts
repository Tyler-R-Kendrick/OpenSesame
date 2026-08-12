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
]);

const DENY_KEY =
  /token|secret|password|authorization|cookie|code_verifier|user.?code|device.?code|refresh|bearer/i;

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
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (DENY_KEY.test(key)) continue;
    if (!AUDIT_METADATA_ALLOWLIST.has(key)) continue;
    if (typeof value === "string") {
      out[key] =
        value.length > AUDIT_VALUE_MAX_LENGTH
          ? `${value.slice(0, AUDIT_VALUE_MAX_LENGTH)}…`
          : value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (value === null) {
      out[key] = null;
    }
  }
  return out;
}
