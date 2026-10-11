/**
 * Legacy hashes and paths that are not themselves a settings category. The
 * Connections, Backups and Cloud secrets categories became the provider
 * sections of Settings › Capabilities, and that page then split in two
 * (ADR 0188): its switches are Settings › Features and its providers
 * Settings › Integrations. `retiredSettingsAddress` carries a link's
 * fragment and file with it.
 */
export const SETTINGS_HASH_ALIAS = new Map<string, string>([
  ["capabilities", "features"],
  ["taskbus", "integrations"],
  ["connectivity", "integrations"],
  ["connections", "integrations"],
  ["backups", "integrations"],
  ["cloud-secrets", "integrations"],
  ["unlock", "security"],
]);

/** The category a retired settings name now reads as, or `undefined`. */
export function retiredSettingsCategory(name: string): string | undefined {
  return SETTINGS_HASH_ALIAS.get(name);
}
