import type { VaultResetRunRecord } from "./vault-run-tracker.js";

export function resetRotationActive(
  existing: VaultResetRunRecord | null,
): boolean {
  return (
    existing?.phase === "in-progress" ||
    (existing?.phase === "needs-you" && existing.runId !== null)
  );
}
