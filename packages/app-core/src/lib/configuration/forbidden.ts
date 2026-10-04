import { normalizeDisplayPath } from "./aliases.js";

const FORBIDDEN_SUFFIXES = [
  "identity-grants",
  "key-wrap",
  "keywrap",
  "replay",
  "sessions",
  "approvals",
  "index",
  "header",
  "body",
  // The vault's device identity key (ADR 0160 §5): a concealed secret.
  "device-identity",
] as const;

/**
 * Internal ledgers are not editable documents. Path guessing must fail closed
 * even when the caller walks `..` or double-encodes.
 */
export function isForbiddenConfigPath(raw: string): boolean {
  const normalized = normalizeDisplayPath(raw);
  if (normalized === null) return true;
  const haystack = normalized.toLowerCase();
  if (haystack.includes("..")) return true;
  return FORBIDDEN_SUFFIXES.some((suffix) => haystack.includes(suffix));
}
