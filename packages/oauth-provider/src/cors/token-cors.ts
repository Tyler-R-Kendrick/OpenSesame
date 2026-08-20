export type TokenCorsDecision = {
  allowed: boolean;
  allowOrigin?: string;
  headers: Record<string, string>;
};

/**
 * Exact-origin CORS for browser token exchange (ADR 0050 F3). Never reflects
 * attacker Origin. clientCanonicalOrigin must come from persisted server state.
 */
export function evaluateTokenCors(
  requestOrigin: string | null | undefined,
  clientCanonicalOrigin: string | null | undefined,
): TokenCorsDecision {
  const baseHeaders = {
    Vary: "Origin",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  };

  if (!requestOrigin || requestOrigin === "null") {
    return { allowed: false, headers: baseHeaders };
  }
  if (!clientCanonicalOrigin) {
    return { allowed: false, headers: baseHeaders };
  }
  if (requestOrigin !== clientCanonicalOrigin) {
    return { allowed: false, headers: baseHeaders };
  }

  return {
    allowed: true,
    allowOrigin: clientCanonicalOrigin,
    headers: {
      ...baseHeaders,
      "Access-Control-Allow-Origin": clientCanonicalOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "600",
    },
  };
}
