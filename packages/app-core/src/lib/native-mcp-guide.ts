/** Display only the schema this server actually advertised, within a finite UI budget. */
import type { NativeMcpTool } from "./native-mcp-protocol.js";
import { NativeMcpError } from "./native-mcp-target.js";

export const NATIVE_MCP_GUIDE_MAX_BYTES = 32_768;
export function nativeMcpInputGuide(
  inputSchema: NativeMcpTool["inputSchema"],
): string {
  const actual = JSON.stringify(inputSchema, null, 2);
  if (new TextEncoder().encode(actual).byteLength > NATIVE_MCP_GUIDE_MAX_BYTES)
    throw new NativeMcpError("response");
  return actual;
}
