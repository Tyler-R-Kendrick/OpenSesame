/**
 * `@opensesame/ingress-evidence/node` — origin re-validation of a forwarded
 * chain with the platform's X.509 implementation (`node:crypto`
 * `X509Certificate`). Never import this from a browser bundle; the parser in
 * the package root is the browser-safe half.
 *
 * What this proves, honestly: that the forwarded end-entity certificate
 * chains to the originating-client trust bundle, is inside its validity
 * window at `now`, and is permitted to authenticate a TLS client. It cannot
 * prove the client held the private key — that handshake happened at the
 * ingress. Callers must only invoke it for a request that arrived from an
 * authenticated, explicitly bound ingress on a `trusted_ingress` listener,
 * and must label the result `trusted_ingress_assertion`.
 */
import { X509Certificate } from "node:crypto";
import type { ForwardedChain } from "./parse.js";

/** Codes are the `TransportError::code()` strings SW-CONTRACT defines. */
export type VerifyErrorCode =
  | "trust_unknown"
  | "evidence_expired"
  | "forwarded_evidence_unverified"
  | "malformed_configuration";

export class OriginatingChainError extends Error {
  readonly code: VerifyErrorCode;
  constructor(code: VerifyErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "OriginatingChainError";
    this.code = code;
  }
}

/** Exact-match selectors, the same four kinds as `PeerIdentitySelector`. */
export type OriginatingSelector =
  | { readonly kind: "spiffe_id"; readonly value: string }
  | { readonly kind: "dns_name"; readonly value: string }
  | { readonly kind: "uri_san"; readonly value: string }
  | { readonly kind: "leaf_thumbprint_sha256"; readonly value: string };

export interface VerifiedOriginatingChain {
  readonly leafThumbprintSha256: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** Validated selectors; always ends with the thumbprint. */
  readonly selectors: readonly OriginatingSelector[];
  /** Certificates in the validated path, leaf first, anchor excluded. */
  readonly pathLength: number;
}

const EKU_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
/** Bound on path building: leaf plus at most this many intermediates. */
const MAX_PATH_INTERMEDIATES = 8;

function fail(code: VerifyErrorCode, detail: string): never {
  throw new OriginatingChainError(code, detail);
}

function parseAnchors(trustPem: string): X509Certificate[] {
  const blocks =
    trustPem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    ) ?? [];
  if (blocks.length === 0)
    fail("malformed_configuration", "trust bundle holds no certificate");
  return blocks.map((block) => {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(block);
    } catch {
      return fail(
        "malformed_configuration",
        "trust bundle certificate does not parse",
      );
    }
    if (!cert.ca) fail("malformed_configuration", "trust anchor is not a CA");
    return cert;
  });
}

function certificate(der: Uint8Array): X509Certificate {
  try {
    return new X509Certificate(Buffer.from(der));
  } catch {
    return fail("forwarded_evidence_unverified", "certificate does not parse");
  }
}

function issued(issuer: X509Certificate, subject: X509Certificate): boolean {
  try {
    return subject.checkIssued(issuer) && subject.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

function checkWindow(cert: X509Certificate, now: Date): void {
  const notBefore = new Date(cert.validFrom);
  const notAfter = new Date(cert.validTo);
  if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime())) {
    fail("forwarded_evidence_unverified", "validity does not parse");
  }
  if (now < notBefore || now > notAfter)
    fail("evidence_expired", "outside validity window");
}

function checkClientAuth(cert: X509Certificate, leaf: boolean): void {
  const eku = cert.keyUsage; // Node reports *extended* key usage OIDs here.
  if (eku === undefined) {
    if (leaf)
      fail("forwarded_evidence_unverified", "leaf has no extendedKeyUsage");
    return;
  }
  if (!eku.includes(EKU_CLIENT_AUTH))
    fail("forwarded_evidence_unverified", "clientAuth not permitted");
}

function selectorsOf(
  leaf: X509Certificate,
  thumbprint: string,
): OriginatingSelector[] {
  const out: OriginatingSelector[] = [];
  const san = leaf.subjectAltName ?? "";
  for (const entry of san.split(", ")) {
    const colon = entry.indexOf(":");
    if (colon === -1) continue;
    const kind = entry.slice(0, colon);
    const value = entry.slice(colon + 1);
    if (kind === "DNS") {
      const lower = value.toLowerCase();
      if (
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(
          lower,
        )
      ) {
        out.push({ kind: "dns_name", value: lower });
      }
    } else if (kind === "URI") {
      if (value.startsWith("spiffe://")) out.push({ kind: "spiffe_id", value });
      else if (/^[a-z][a-z0-9+.-]*:\S+$/i.test(value))
        out.push({ kind: "uri_san", value });
    }
  }
  out.push({ kind: "leaf_thumbprint_sha256", value: thumbprint });
  return out;
}

/**
 * Re-validates `chain` against `trustPem` at `now` for TLS client
 * authentication. Throws `OriginatingChainError`; never returns partially.
 */
export function verifyOriginatingChain(
  chain: ForwardedChain,
  trustPem: string,
  now: Date,
): VerifiedOriginatingChain {
  const anchors = parseAnchors(trustPem);
  const leaf = certificate(chain.leafDer);
  if (leaf.ca) fail("forwarded_evidence_unverified", "leaf is a CA");
  const pool = chain.intermediatesDer.map(certificate);
  if (pool.length > MAX_PATH_INTERMEDIATES)
    fail("forwarded_evidence_unverified", "chain too long");
  const path: X509Certificate[] = [leaf];
  let current = leaf;
  for (let depth = 0; depth <= MAX_PATH_INTERMEDIATES; depth += 1) {
    if (anchors.some((anchor) => issued(anchor, current))) {
      for (const cert of path) checkWindow(cert, now);
      checkClientAuth(leaf, true);
      for (const cert of path.slice(1)) {
        if (!cert.ca)
          fail("forwarded_evidence_unverified", "intermediate is not a CA");
        checkClientAuth(cert, false);
      }
      return {
        leafThumbprintSha256: chain.leafThumbprintSha256,
        notBefore: new Date(leaf.validFrom),
        notAfter: new Date(leaf.validTo),
        selectors: selectorsOf(leaf, chain.leafThumbprintSha256),
        pathLength: path.length,
      };
    }
    const index = pool.findIndex(
      (candidate) => !path.includes(candidate) && issued(candidate, current),
    );
    if (index === -1) break;
    current = pool[index] as X509Certificate;
    path.push(current);
  }
  return fail("trust_unknown", "chain does not reach a trust anchor");
}
