/**
 * Resource-side certificate-bound token check (RFC 8705 §3, ID-RESOURCE).
 *
 * Claim shape, exactly as oidc-provider mints it in JWT access tokens and
 * returns it from introspection — SW-SERVICE mirrors this in the Rust Host:
 *
 * ```json
 * { "cnf": { "x5t#S256": "<base64url(SHA-256(leaf certificate DER))>" } }
 * ```
 *
 * The digest is over the certificate's DER bytes, not the public key: a
 * different certificate carrying the same key has a different thumbprint and
 * is rejected (AT-OAUTH-SWAP). It is compared against the request's binding
 * peer — the originating client behind a trusted ingress, never the ingress
 * leaf (AT-OAUTH-PROXY) — and never against anything a header or body says.
 * A `cnf.jkt` DPoP confirmation is a different proof profile; this module
 * leaves it to the DPoP path untouched.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type BoundaryValue,
  type JsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { VerifiedPeer } from "./peer-evidence.js";
import { bindingPeerOf } from "./request-evidence.js";

export const CNF_X5T_S256 = "x5t#S256";
const B64U_SHA256 = /^[A-Za-z0-9_-]{43}$/;

export type BindingCheck =
  | { ok: true; bound: boolean }
  | {
      ok: false;
      code: "certificate_binding_missing_peer" | "certificate_binding_mismatch";
    };

/**
 * The `x5t#S256` a token is bound to, from a JWT payload (`cnf`), an
 * introspection body (`cnf`), or an oidc-provider token model (top-level
 * `'x5t#S256'`). Undefined when the token carries no certificate binding.
 */
export function certificateConfirmationOf(
  token: BoundaryValue,
): string | undefined {
  if (token === null || typeof token !== "object") return undefined;
  const record: JsonObject = overlapCast(token);
  const cnf = record.cnf;
  const fromCnf =
    cnf !== null && typeof cnf === "object" && !Array.isArray(cnf)
      ? cnf[CNF_X5T_S256]
      : undefined;
  const value = fromCnf ?? record[CNF_X5T_S256];
  return isString(value) && value.length > 0 ? value : undefined;
}

/** Compare a token's binding against the peer that presented it. */
export function evaluateCertificateBinding(
  expected: string | undefined,
  peer: VerifiedPeer | undefined,
): BindingCheck {
  if (expected === undefined) return { ok: true, bound: false };
  if (!peer) return { ok: false, code: "certificate_binding_missing_peer" };
  if (!B64U_SHA256.test(expected) || peer.leafThumbprintB64u() !== expected) {
    return { ok: false, code: "certificate_binding_mismatch" };
  }
  return { ok: true, bound: true };
}

/** Check a token against the request it arrived on. */
export function checkRequestTokenBinding(
  req: IncomingMessage | object | undefined,
  token: BoundaryValue,
): BindingCheck {
  return evaluateCertificateBinding(
    certificateConfirmationOf(token),
    bindingPeerOf(req),
  );
}

/** Decode a bearer JWT's payload without verifying it (binding pre-check only). */
export function decodeBearerJwtPayload(
  authorization: string | undefined,
): JsonObject | undefined {
  if (!authorization?.toLowerCase().startsWith("bearer ")) return undefined;
  const token = authorization.slice(7).trim();
  if (token.length === 0 || token.length > 8192) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const parsed: BoundaryValue = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? overlapCast(parsed)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pre-dispatch gate for every Hono route: a bearer JWT that names a
 * certificate binding is refused unless this request's binding peer matches.
 * Fail-closed and grant-free — a forged `cnf` can only make a request fail;
 * the token's signature and audience are verified downstream as before.
 * Returns true when the response was written.
 */
export function rejectMismatchedBoundBearer(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const payload = decodeBearerJwtPayload(req.headers.authorization);
  if (!payload) return false;
  const check = checkRequestTokenBinding(req, payload);
  if (check.ok) return false;
  res.statusCode = 401;
  res.setHeader(
    "www-authenticate",
    `Bearer error="invalid_token", error_description="${check.code}"`,
  );
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({ error: "invalid_token", error_description: check.code }),
  );
  return true;
}
