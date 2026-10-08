/** Host API tools removed — registry mcp_client catalog is empty. */
export const toolsManifest = [] as const;

export function assertsNoMaterializeTool(names: readonly string[]): void {
  if (
    names.some((n) => /materialize|get_secret|getSecret|present_claim/i.test(n))
  ) {
    throw new Error("materialize_tools_forbidden");
  }
}
