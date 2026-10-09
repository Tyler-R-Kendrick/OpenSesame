/**
 * RFC 9440 field extraction and origin re-validation for the Identity
 * plane's trusted-ingress profile, delegated to `@opensesame/ingress-evidence`
 * (SW-INGRESS): the same bounded parser and error codes the Rust crate and
 * the ingress reference configuration use. This adapter only shapes the
 * results for the request resolver; it never trusts a header.
 */
import { X509Certificate } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  type ForwardedChain,
  IngressEvidenceError,
  hasClientCertFields,
  pairsFromRawHeaders,
  parseClientCertFields,
  stripClientCertFields,
} from "@opensesame/ingress-evidence";
import {
  OriginatingChainError,
  verifyOriginatingChain,
} from "@opensesame/ingress-evidence/node";

export type ClientCertFields =
  | { present: false }
  | { present: true; chain: ForwardedChain }
  | { present: true; error: string };

/** Extract the RFC 9440 fields from a request's physical headers. */
export function extractClientCertFields(
  rawHeaders: readonly string[],
): ClientCertFields {
  const pairs = pairsFromRawHeaders(rawHeaders);
  if (!hasClientCertFields(pairs)) return { present: false };
  try {
    return { present: true, chain: parseClientCertFields(pairs) };
  } catch (error) {
    if (error instanceof IngressEvidenceError) {
      return { present: true, error: error.message };
    }
    return { present: true, error: "malformed_structured_field" };
  }
}

export type ForwardedVerification =
  | { ok: true; leaf: X509Certificate }
  | { ok: false; error: string };

/** Re-validate a forwarded chain against the originating trust bundle. */
export function verifyForwarded(
  chain: ForwardedChain,
  trustPem: string,
  now: Date,
): ForwardedVerification {
  try {
    verifyOriginatingChain(chain, trustPem, now);
    return { ok: true, leaf: new X509Certificate(Buffer.from(chain.leafDer)) };
  } catch (error) {
    if (error instanceof OriginatingChainError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: "forwarded_evidence_unverified" };
  }
}

/**
 * Remove every RFC 9440 field from a request that did not arrive on the
 * trusted-ingress listener, so no handler downstream can read one. Both
 * views are rewritten: Hono builds its `Headers` from `rawHeaders`, the raw
 * OAuth branch reads `headers`.
 */
export function stripForwardedEvidence(req: IncomingMessage): void {
  const pairs = pairsFromRawHeaders(req.rawHeaders);
  if (!hasClientCertFields(pairs)) return;
  req.rawHeaders = stripClientCertFields(pairs).flat();
  req.headers = Object.fromEntries(
    Object.entries(req.headers).filter(
      ([name]) => name !== "client-cert" && name !== "client-cert-chain",
    ),
  );
}

/** Header names an ingress must strip and an origin must never trust raw. */
export const CALLER_SUPPLIED_EVIDENCE_HEADERS = [
  "client-cert",
  "client-cert-chain",
  "x-client-cert",
  "x-forwarded-client-cert",
  "x-ssl-client-cert",
] as const;
