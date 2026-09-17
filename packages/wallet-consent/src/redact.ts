/**
 * WAL-B17 — redacted Wallet exports must not echo seeded secret canaries.
 */

const CANARY = /CANARY_[A-Za-z0-9_-]+/g;
const KEYISH = /\b(?:sk|pk|api)[_-][A-Za-z0-9_-]{8,}\b/gi;
const LONG_HEX = /\b[A-Fa-f0-9]{64}\b/g;

export function redactWalletExport(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text
    .replace(CANARY, "[redacted-canary]")
    .replace(KEYISH, "[redacted]")
    .replace(LONG_HEX, "[redacted-hex]");
}

export function walletExportLeaksCanary(
  exportText: string,
  canaries: readonly string[],
): boolean {
  return canaries.some(
    (canary) => canary.length > 0 && exportText.includes(canary),
  );
}
