/**
 * Union of the per-app secret-name denylists
 * (apps/mcp-host assertsNoSecretTools + apps/mcp-client
 * assertsNoMaterializeTool), applied to every agent catalog including WebMCP.
 */
export const AGENT_SECRET_NAME_PATTERN =
  /secret|materialize|get_secret|pass_show|sealed_store_show|password_store_read|^show$/i;

export function assertsNoSecretNames(names: readonly string[]): void {
  if (names.some((n) => AGENT_SECRET_NAME_PATTERN.test(n))) {
    throw new Error("secret_tools_forbidden");
  }
}
