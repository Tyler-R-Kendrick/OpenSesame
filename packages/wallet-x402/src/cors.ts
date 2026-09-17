/**
 * WAL-E12 — browser CORS / redirect gate for x402 exact.
 * Missing ACAO, wildcard origin, unexposed payment headers, or forwarding a
 * signed authorization across a redirect is refused.
 */

export type ExactCorsRefusal =
  | "CORS_ORIGIN_REFUSED"
  | "CORS_HEADERS_UNEXPOSED"
  | "REDIRECT_CREDENTIAL_FORWARDING_REFUSED";

export type ExactCorsAssessment =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ExactCorsRefusal };

const REQUIRED_EXPOSE = ["payment-required", "payment-signature"] as const;

export function assessExactPaymentCors(input: {
  readonly requestOrigin: string;
  readonly accessControlAllowOrigin: string | null;
  readonly accessControlExposeHeaders: string | null;
  readonly credentialForwardingOnRedirect: boolean;
  readonly redirectStatus?: number;
}): ExactCorsAssessment {
  if (input.credentialForwardingOnRedirect) {
    return { ok: false, code: "REDIRECT_CREDENTIAL_FORWARDING_REFUSED" };
  }
  if (
    input.redirectStatus !== undefined &&
    input.redirectStatus >= 300 &&
    input.redirectStatus < 400
  ) {
    return { ok: false, code: "REDIRECT_CREDENTIAL_FORWARDING_REFUSED" };
  }
  const allowOrigin = input.accessControlAllowOrigin;
  if (
    allowOrigin === null ||
    allowOrigin === "*" ||
    allowOrigin === "null" ||
    allowOrigin !== input.requestOrigin
  ) {
    return { ok: false, code: "CORS_ORIGIN_REFUSED" };
  }
  const exposed = (input.accessControlExposeHeaders ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase());
  for (const header of REQUIRED_EXPOSE) {
    if (!exposed.includes(header)) {
      return { ok: false, code: "CORS_HEADERS_UNEXPOSED" };
    }
  }
  return { ok: true };
}
