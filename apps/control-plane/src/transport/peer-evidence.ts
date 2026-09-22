/**
 * Verified transport peer evidence for the Identity plane (CONTRACT §3).
 *
 * `VerifiedPeer` mirrors `opensesame_domain::transport::VerifiedPeer`: private
 * fields, no public constructor, never built from JSON, headers or a request
 * body. The only producer is {@link attestPeer}, which the TLS listener calls
 * with what the Node runtime actually verified (`socket.authorized === true`
 * plus the peer `X509Certificate`), and the trusted-ingress resolver calls
 * with a chain it verified itself against the originating trust file.
 *
 * Types are the canonical `@opensesame/os-domain` transport-security mirror
 * (SW-CONTRACT); `view()` serializes exactly as the Rust `PeerEvidenceView`.
 * os-domain has no runtime `attest` constructor (it is pure and value-blind),
 * so this module is the Identity plane's privileged producer.
 */
import { X509Certificate, createHash } from "node:crypto";
import { decodeSelector, selectorsEqual } from "@opensesame/os-domain";
import type {
  EvidenceSource,
  PeerEvidenceView,
  PeerIdentitySelector,
  TlsVersion,
  TransportPolicy,
  TrustProfileRef,
} from "@opensesame/os-domain";

export type {
  EvidenceSource,
  PeerEvidenceView,
  PeerIdentitySelector,
  TlsVersion,
  TransportPolicy,
  TrustProfileRef,
};

/** Everything the producer verified. Mirrors `attest::AttestedPeer`. */
export interface AttestedPeer {
  source: EvidenceSource;
  leaf: X509Certificate;
  trustProfile: TrustProfileRef;
  trustGeneration: number;
  credentialGeneration: number;
  listener: string;
  policy: TransportPolicy;
  tlsVersion: TlsVersion;
  authenticatedAt: Date;
  /** `usable_until = authenticated_at + min(usableFor, certificate remaining)`. */
  usableForMs: number;
  ingress?: VerifiedPeer;
}

/** The capability `attestPeer` holds and nothing else can obtain. */
const ATTEST_ONLY: unique symbol = Symbol("attestPeer");

export class PeerEvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PeerEvidenceError";
  }
}

const SAN_SPLIT =
  /, (?=(?:DNS|URI|IP Address|email|othername|DirName|Registered ID):)/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Lowercase hex SHA-256 of the leaf DER — the `leaf_thumbprint_sha256` selector. */
export function leafThumbprintHex(leaf: X509Certificate): string {
  return createHash("sha256").update(leaf.raw).digest("hex");
}

/** base64url SHA-256 of the leaf DER — the RFC 8705 `cnf["x5t#S256"]` value. */
export function leafThumbprintB64u(leaf: X509Certificate): string {
  return createHash("sha256").update(leaf.raw).digest("base64url");
}

/**
 * Accept a candidate selector only if the canonical `@opensesame/os-domain`
 * decoder — the rule-for-rule mirror of the Rust validator — accepts it.
 * Validating here with a second, looser set of regexes is how the two planes
 * come to disagree about what a certificate says, so there is only one.
 */
function accepted(
  kind: "dns_name" | "uri_san" | "spiffe_id",
  value: string,
): PeerIdentitySelector | undefined {
  const decoded = decodeSelector("peer", { [kind]: value });
  return decoded.ok ? decoded.value : undefined;
}

/**
 * The selectors a leaf presents: validated DNS and URI SANs plus the
 * thumbprint. Anything else on the certificate (CN, email, IP) is not an
 * identity here and is dropped, never lowered into a name.
 *
 * A SPIFFE identity is derived only when the leaf carries **exactly one**
 * `spiffe://` URI SAN and it is well formed. Two of them are an ambiguous
 * SVID: neither is an identity, and neither is demoted to a plain URI
 * selector either. This mirrors `ParsedLeaf::parse` in
 * `crates/transport-security`.
 */
export function selectorsOf(leaf: X509Certificate): PeerIdentitySelector[] {
  const entries: Array<["dns_name" | "uri_san", string]> = [];
  const raw = leaf.subjectAltName ?? "";
  for (const entry of raw ? raw.split(SAN_SPLIT) : []) {
    if (entry.startsWith("DNS:")) {
      entries.push(["dns_name", entry.slice(4).toLowerCase()]);
    } else if (entry.startsWith("URI:")) {
      entries.push(["uri_san", entry.slice(4)]);
    }
  }
  const spiffeCount = entries.filter(
    ([kind, value]) => kind === "uri_san" && value.startsWith("spiffe://"),
  ).length;
  const out: PeerIdentitySelector[] = [];
  for (const [kind, value] of entries) {
    const isSpiffe = kind === "uri_san" && value.startsWith("spiffe://");
    // Two SPIFFE SANs are an ambiguous SVID: neither is an identity, and
    // neither is demoted to a plain URI selector either.
    if (isSpiffe && spiffeCount !== 1) continue;
    const selector = accepted(isSpiffe ? "spiffe_id" : kind, value);
    if (selector && !out.some((s) => selectorsEqual(s, selector))) {
      out.push(selector);
    }
  }
  out.push({ leaf_thumbprint_sha256: leafThumbprintHex(leaf) });
  return out;
}

/**
 * Build verified evidence from producer-verified inputs. Throws when the
 * material is not usable (expired at attestation, malformed thumbprint) so a
 * listener cannot register a peer it should have refused.
 */
export function attestPeer(input: AttestedPeer): VerifiedPeer {
  const notBefore = input.leaf.validFromDate;
  const notAfter = input.leaf.validToDate;
  const now = input.authenticatedAt.getTime();
  if (!(now >= notBefore.getTime() && now < notAfter.getTime())) {
    throw new PeerEvidenceError(
      "evidence_expired",
      "peer certificate is outside its validity window",
    );
  }
  const thumbprint = leafThumbprintHex(input.leaf);
  if (!HEX64.test(thumbprint)) {
    throw new PeerEvidenceError("malformed_configuration", "bad thumbprint");
  }
  if (input.usableForMs <= 0) {
    throw new PeerEvidenceError("malformed_configuration", "usableFor <= 0");
  }
  const usableUntil = new Date(
    Math.min(now + input.usableForMs, notAfter.getTime()),
  );
  return new VerifiedPeer(ATTEST_ONLY, input, thumbprint, usableUntil);
}

/**
 * Internal verified evidence. No `fromJSON`, and no reachable constructor:
 * the class is exported for its type and its getters, and the constructor
 * demands a module-private token no caller outside this file can name. The
 * door is {@link attestPeer}, which is where the validity window is checked
 * and the thumbprint is computed rather than supplied.
 */
export class VerifiedPeer {
  readonly #input: AttestedPeer;
  readonly #identities: PeerIdentitySelector[];
  readonly #thumbprint: string;
  readonly #usableUntil: Date;

  /** @internal Only {@link attestPeer} can name `ATTEST_ONLY`. */
  constructor(
    token: symbol,
    input: AttestedPeer,
    thumbprint: string,
    usableUntil: Date,
  ) {
    if (token !== ATTEST_ONLY) {
      throw new PeerEvidenceError(
        "source_unsupported",
        "verified peer evidence is produced by attestPeer only",
      );
    }
    if (!(input.leaf instanceof X509Certificate)) {
      throw new PeerEvidenceError("source_unsupported", "leaf is not X.509");
    }
    this.#input = input;
    this.#identities = selectorsOf(input.leaf);
    this.#thumbprint = thumbprint;
    this.#usableUntil = usableUntil;
  }

  source(): EvidenceSource {
    return this.#input.source;
  }
  identities(): readonly PeerIdentitySelector[] {
    return this.#identities;
  }
  leafThumbprintSha256(): string {
    return this.#thumbprint;
  }
  /** RFC 8705 §3 form of the same digest. */
  leafThumbprintB64u(): string {
    return leafThumbprintB64u(this.#input.leaf);
  }
  notBefore(): Date {
    return this.#input.leaf.validFromDate;
  }
  notAfter(): Date {
    return this.#input.leaf.validToDate;
  }
  trustProfile(): TrustProfileRef {
    return { name: this.#input.trustProfile.name };
  }
  trustGeneration(): number {
    return this.#input.trustGeneration;
  }
  credentialGeneration(): number {
    return this.#input.credentialGeneration;
  }
  listener(): string {
    return this.#input.listener;
  }
  policy(): TransportPolicy {
    return this.#input.policy;
  }
  tlsVersion(): TlsVersion {
    return this.#input.tlsVersion;
  }
  authenticatedAt(): Date {
    return this.#input.authenticatedAt;
  }
  usableUntil(): Date {
    return this.#usableUntil;
  }
  /** Set only for `trusted_ingress_assertion`: the authenticated ingress. */
  ingress(): VerifiedPeer | undefined {
    return this.#input.ingress;
  }
  /** PEM of the verified leaf, for oidc-provider's `getCertificate`. */
  certificatePem(): string {
    return this.#input.leaf.toString();
  }
  /** Whether `now` is inside the evidence's usable window. */
  usableAt(now: Date): boolean {
    return now.getTime() <= this.#usableUntil.getTime();
  }
  view(): PeerEvidenceView {
    return {
      source: this.#input.source,
      identities: this.#identities.map((s) => ({ ...s })),
      leaf_thumbprint_sha256: this.#thumbprint,
      not_before: this.notBefore().toISOString(),
      not_after: this.notAfter().toISOString(),
      trust_profile: this.trustProfile(),
      trust_generation: this.#input.trustGeneration,
      credential_generation: this.#input.credentialGeneration,
      listener: this.#input.listener,
      policy: this.#input.policy,
      tls_version: this.#input.tlsVersion,
      authenticated_at: this.#input.authenticatedAt.toISOString(),
      usable_until: this.#usableUntil.toISOString(),
      ingress: this.#input.ingress?.view() ?? null,
    };
  }
  toJSON(): PeerEvidenceView {
    return this.view();
  }
}
