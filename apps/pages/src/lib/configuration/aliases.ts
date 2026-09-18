import { PREFS_RESOURCE_KEY } from "./prefs-keys.js";

/** Canonical display path plus documented aliases for one prefs resource. */
export const PREFS_DISPLAY_PATH = "settings/prefs.yaml";

export const PREFS_PATH_ALIASES: readonly string[] = [
  PREFS_DISPLAY_PATH,
  "settings/prefs.yml",
  ".config/opensesame/prefs.yaml",
];

const ALIAS_TO_KEY = new Map<string, string>(
  PREFS_PATH_ALIASES.map((alias) => [alias, PREFS_RESOURCE_KEY]),
);

/**
 * Normalize a navigation/display path. Rejects traversal, absolute paths,
 * NUL, and over-decoding tricks. Does not touch VFS storage.
 */
export function normalizeDisplayPath(raw: string): string | null {
  if (raw.includes("\0")) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  if (decoded.startsWith("/") || decoded.includes("://")) return null;
  const stack: string[] = [];
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    stack.push(part);
  }
  return stack.join("/");
}

/** Resolve a display path to a registry resource key, or null. */
export function resolveResourceAlias(raw: string): string | null {
  const normalized = normalizeDisplayPath(raw);
  if (normalized === null) return null;
  return ALIAS_TO_KEY.get(normalized) ?? null;
}
