/** Fixed issuance budget and clock-window cleanup; this metadata grants no authority. */
export interface PendingCodeWindow {
  issuedAt: number;
  expiresAt: number;
}
export function reclaimPendingCodes<T extends PendingCodeWindow>(
  codes: Map<string, T>,
  now: number,
): void {
  for (const [key, code] of codes)
    if (code.expiresAt <= now || code.issuedAt > now) codes.delete(key);
}
export function pendingCodeBudgetFull(
  codes: ReadonlyMap<string, PendingCodeWindow>,
): boolean {
  return codes.size >= 128;
}
