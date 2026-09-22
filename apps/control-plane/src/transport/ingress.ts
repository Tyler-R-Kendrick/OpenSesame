/**
 * Trusted-ingress originating evidence (CONTRACT §3 `TrustedIngressAssertion`).
 *
 * On the `trusted_ingress` listener policy, and only when the socket peer
 * resolves to a `trusted_ingress`-purpose binding allowed `ingress.forward`,
 * the RFC 9440 fields are parsed, the forwarded chain is re-validated
 * against `OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE`, and the result is
 * attached to this one request as a `VerifiedPeer` whose `source()` is
 * `trusted_ingress_assertion` and whose `ingress()` is the socket peer.
 *
 * The forwarded certificate is public: what is trusted is the authenticated
 * ingress and its validation contract, never the header. The origin cannot
 * recreate the original handshake, so the source is labelled honestly and
 * the ingress leaf is never presented as the client.
 */
import {
  extractClientCertFields,
  verifyForwarded,
} from "./ingress-evidence-adapter.js";
import {
  type TlsVersion,
  type VerifiedPeer,
  attestPeer,
} from "./peer-evidence.js";
import { type ServiceBindingSet, admitService } from "./service-admission.js";

export const INGRESS_FORWARD_OPERATION = "ingress.forward";

export type OriginatingResolution =
  | { kind: "none" }
  | { kind: "verified"; originating: VerifiedPeer }
  | { kind: "refused"; error: string };

export interface ResolveOriginatingInput {
  /** `IncomingMessage.rawHeaders`: physical fields, repeats preserved. */
  rawHeaders: readonly string[];
  ingressPeer: VerifiedPeer | undefined;
  bindings: ServiceBindingSet;
  /** PEM bundle of originating-client trust anchors. */
  trustPem: string;
  listener: string;
  trustProfile: string;
  trustGeneration: number;
  credentialGeneration: number;
  tlsVersion: TlsVersion;
  now: Date;
  usableForMs: number;
}

/** Resolve originating evidence for one request on a trusted-ingress listener. */
export function resolveOriginating(
  input: ResolveOriginatingInput,
): OriginatingResolution {
  const fields = extractClientCertFields(input.rawHeaders);
  if (!fields.present) return { kind: "none" };
  if ("error" in fields) return { kind: "refused", error: fields.error };
  if (!input.ingressPeer) {
    return {
      kind: "refused",
      error: "forwarded evidence without an authenticated ingress",
    };
  }
  const admitted = admitService(
    input.bindings,
    input.ingressPeer,
    "trusted_ingress",
    INGRESS_FORWARD_OPERATION,
    input.now,
  );
  if (!admitted.ok) {
    return {
      kind: "refused",
      error: `ingress not bound to forward: ${admitted.code}`,
    };
  }
  const verified = verifyForwarded(fields.chain, input.trustPem, input.now);
  if (!verified.ok) return { kind: "refused", error: verified.error };
  try {
    const originating = attestPeer({
      source: "trusted_ingress_assertion",
      leaf: verified.leaf,
      trustProfile: { name: input.trustProfile },
      trustGeneration: input.trustGeneration,
      credentialGeneration: input.credentialGeneration,
      listener: input.listener,
      policy: "trusted_ingress",
      tlsVersion: input.tlsVersion,
      authenticatedAt: input.now,
      usableForMs: input.usableForMs,
      ingress: input.ingressPeer,
    });
    return { kind: "verified", originating };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "attestation failed";
    return { kind: "refused", error: message };
  }
}
