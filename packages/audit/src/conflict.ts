/** PostgreSQL drivers and Drizzle wrap the same unique-predecessor conflict differently. */
export function isAuditPredecessorConflict(error: Error): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    const constraint =
      "constraint_name" in current
        ? current.constraint_name
        : "constraint" in current
          ? current.constraint
          : undefined;
    if (
      "code" in current &&
      current.code === "23505" &&
      constraint === "audit_events_previous_digest_uidx"
    )
      return true;
    current = current.cause;
  }
  return false;
}

export function auditConflictRetryLimit(
  error: Error,
  custom?: (error: Error) => boolean,
): number {
  if (isAuditPredecessorConflict(error)) return 31;
  return custom?.(error) ? 1 : 0;
}
