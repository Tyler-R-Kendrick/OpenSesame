/**
 * MCP Bearer profile notes (RFC 6750 + MCP Authorization 2026-07-28).
 *
 * - Access tokens are presented in the Authorization header as Bearer.
 * - OpenSesame never forwards inbound tokens as downstream credentials.
 * - Task-scoped tools route through Host API /api/v1/tasks*, not raw secret access.
 */

export const MCP_BEARER_PROFILE = "mcp-authorization-2026-07-28-bearer";

export function parseBearerAuthorization(
  header: string | undefined,
): { scheme: string; token: string } | null {
  if (!header) {
    return null;
  }
  const space = header.indexOf(" ");
  if (space <= 0) {
    return null;
  }
  const scheme = header.slice(0, space).trim();
  const token = header.slice(space + 1).trim();
  if (!token) {
    return null;
  }
  return { scheme, token };
}

export function assertBearerScheme(scheme: string): void {
  if (scheme.toLowerCase() !== "bearer") {
    throw new Error("bearer_scheme_required");
  }
}
