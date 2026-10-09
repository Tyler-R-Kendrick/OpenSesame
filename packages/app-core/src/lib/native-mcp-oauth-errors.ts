/** Preserve only OAuth error codes needed for recovery, never provider descriptions. */
import {
  InvalidClientError,
  InvalidGrantError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import { NativeMcpError } from "./native-mcp-target.js";

export async function mcpOAuthAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof NativeMcpError || error instanceof NativeMcpAuthError)
      throw error;
    if (error instanceof InvalidGrantError)
      throw new NativeMcpAuthError("authorization", "invalid_grant");
    if (error instanceof InvalidClientError)
      throw new NativeMcpAuthError("authorization", "invalid_client");
    throw new NativeMcpAuthError("authorization");
  }
}
