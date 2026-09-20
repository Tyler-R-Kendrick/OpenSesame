/** Vercel Connect managed connectors — Vercel registers the provider app. */
export const MANAGED_CONNECTOR_IDS = new Set([
  "linear",
  "linq",
  "microsoft",
  "microsoft-teams",
  "salesforce",
  "slack",
  "snowflake",
]);

export function isManagedConnector(id: string): boolean {
  return MANAGED_CONNECTOR_IDS.has(id);
}
