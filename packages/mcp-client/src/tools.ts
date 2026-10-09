/** Declared tools — materialize intentionally absent. */
export const toolsManifest = [
  "host_health",
  "whoami",
  "host_discover",
  "sync_push",
  "sync_pull",
] as const;

export function assertsNoMaterializeTool(names: readonly string[]): void {
  if (
    names.some((n) => /materialize|get_secret|getSecret|present_claim/i.test(n))
  ) {
    throw new Error("materialize_tools_forbidden");
  }
}
