/** The untrusted forwarded chain and the checks that admit one for verification. */
import { inspectCertificate } from "./der.js";
import { type IngressField, ingressError } from "./error.js";
import {
  type HeaderPair,
  collect,
  decodeChainField,
  decodeLeaf,
} from "./fields.js";
import { DEFAULT_INGRESS_LIMITS, type IngressLimits } from "./limits.js";
import { sha256Hex } from "./sha256.js";

/**
 * Certificates a proxy claims its client presented. **Untrusted.**
 *
 * Nothing here has been checked against a trust bundle, a validity window or
 * a key-usage rule. The only guarantees are that each member is exactly one
 * DER certificate within the limits, that the leaf is a single end-entity
 * certificate, and that the chain holds no second end-entity certificate.
 * Pass it to `verifyOriginatingChain` (`@opensesame/ingress-evidence/node`)
 * before deriving any identity from it.
 */
export interface ForwardedChain {
  /** DER of the end-entity certificate from Client-Cert. */
  readonly leafDer: Uint8Array;
  /** DER of every Client-Cert-Chain member in wire order, a leading duplicate of the leaf removed. */
  readonly intermediatesDer: readonly Uint8Array[];
  /** Lowercase hex SHA-256 of the leaf DER. Safe to log. */
  readonly leafThumbprintSha256: string;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function checkSize(
  der: Uint8Array,
  field: IngressField,
  limits: IngressLimits,
): void {
  if (der.length > limits.maxCertificateBytes)
    throw ingressError("certificate_too_large", field);
}

function isCa(der: Uint8Array, field: IngressField): boolean {
  const info = inspectCertificate(der);
  if (info === null) throw ingressError("not_der_certificate", field);
  return info.ca;
}

/**
 * Parses Client-Cert and Client-Cert-Chain (RFC 9440) out of the physical
 * header fields, in the same order and with the same codes as the Rust
 * `parse_client_cert_fields`: total bytes, leaf multiplicity, leaf presence,
 * structured-field syntax (including non-canonical base64), member type,
 * parameters, empty members, decoded size, chain length, DER shape, then
 * leaf/chain conflict. Throws `IngressEvidenceError`; never anything else.
 *
 * Pass physical fields (`pairsFromRawHeaders`). A fetch `Headers` object has
 * already joined repeated fields with `, `, which turns a repeated Client-Cert
 * into `malformed_structured_field` rather than `leaf_repeated`; it is still
 * refused, only the code differs.
 */
export function parseClientCertFields(
  headers: Iterable<HeaderPair>,
  limits: IngressLimits = DEFAULT_INGRESS_LIMITS,
): ForwardedChain {
  const raw = collect(headers, limits);
  const leaf = decodeLeaf(raw.leaf[0] as string);
  const members: Uint8Array[] = [];
  for (const value of raw.chain) members.push(...decodeChainField(value));
  checkSize(leaf, "client-cert", limits);
  for (const member of members) checkSize(member, "client-cert-chain", limits);
  const first = members[0];
  if (first !== undefined && bytesEqual(first, leaf)) members.shift();
  if (members.length > limits.maxChainCertificates)
    throw ingressError("chain_too_long", "client-cert-chain");
  if (isCa(leaf, "client-cert"))
    throw ingressError("conflicting_leaf", "client-cert-chain");
  for (const member of members) {
    if (!isCa(member, "client-cert-chain") || bytesEqual(member, leaf)) {
      throw ingressError("conflicting_leaf", "client-cert-chain");
    }
  }
  return {
    leafDer: leaf,
    intermediatesDer: members,
    leafThumbprintSha256: sha256Hex(leaf),
  };
}

/** Node `IncomingMessage.rawHeaders` (alternating name, value) as physical pairs. */
export function pairsFromRawHeaders(
  rawHeaders: readonly string[],
): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    pairs.push([rawHeaders[i] as string, rawHeaders[i + 1] as string]);
  }
  return pairs;
}

/** Removes every Client-Cert and Client-Cert-Chain field, whatever their case. */
export function stripClientCertFields(
  headers: Iterable<HeaderPair>,
): HeaderPair[] {
  const kept: HeaderPair[] = [];
  for (const pair of headers) {
    const lower = pair[0].toLowerCase();
    if (lower !== "client-cert" && lower !== "client-cert-chain")
      kept.push(pair);
  }
  return kept;
}
