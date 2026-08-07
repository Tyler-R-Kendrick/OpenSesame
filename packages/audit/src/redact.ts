/**
 * Allowlisted metadata keys that may appear in audit events.
 * Anything else is dropped; secrets matching deny patterns are stripped.
 */
export const AUDIT_METADATA_ALLOWLIST = new Set([
  "reason",
  "action",
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

export function redactAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (DENY_KEY.test(key)) continue;
    if (!AUDIT_METADATA_ALLOWLIST.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (value === null) {
      out[key] = null;
    }
  }
  return out;
}
