/** Declared tools — materialize intentionally absent. */
export const toolsManifest = [
  "host_health",
  "list_connections",
  "invoke_l1",
  "whoami",
  "present_claim",
  "host_discover",
  "integration_read",
  "sync_target_read",
  "config_metadata_read",
  "sync_push",
  "sync_pull",
] as const;

export function assertsNoMaterializeTool(names: readonly string[]): void {
  if (names.some((n) => /materialize|get_secret|getSecret/i.test(n))) {
    throw new Error("materialize_tools_forbidden");
  }
}
