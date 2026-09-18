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
] as const;

/**
 * Internal ledgers are not editable documents. Path guessing must fail closed
 * even when the caller walks `..` or double-encodes.
 */
export function isForbiddenConfigPath(raw: string): boolean {
  const normalized = normalizeDisplayPath(raw);
  const haystack = (normalized ?? raw).toLowerCase();
  if (haystack.includes("..")) return true;
  return FORBIDDEN_SUFFIXES.some((suffix) => haystack.includes(suffix));
}
