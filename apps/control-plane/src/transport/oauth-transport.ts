/**
 * The `MtlsTransport` the OpenSesame issuer is created with when the TLS
 * listener is configured (ID-OAUTH): `peerOf` answers from the listener's
 * socket registry — a plain socket, an unauthenticated TLS socket and any
 * header claim all resolve to nothing — and the endpoint-alias base is the
 * listener's own public URL when it has one.
 */
import type { MtlsPeer, MtlsTransport } from "@opensesame/oauth-provider";
import type { TransportConfig } from "./config.js";
import { peerOf } from "./listener.js";
import type { VerifiedPeer } from "./peer-evidence.js";

/** The issuer's view of a verified peer: PEM plus exact SAN selectors. */
export function mtlsPeerOf(peer: VerifiedPeer): MtlsPeer {
  const dns: string[] = [];
  const uris: string[] = [];
  for (const selector of peer.identities()) {
    if ("dns_name" in selector) dns.push(selector.dns_name);
    else if ("uri_san" in selector) uris.push(selector.uri_san);
    else if ("spiffe_id" in selector) uris.push(selector.spiffe_id);
  }
  return {
    certificatePem: () => peer.certificatePem(),
    dnsNames: () => dns,
    uris: () => uris,
  };
}

/** Undefined when no TLS listener is configured, so `features.mTLS` stays off. */
export function identityMtlsTransport(
  transport: TransportConfig | undefined,
): MtlsTransport | undefined {
  const listener = transport?.listener;
  if (!listener) return undefined;
  const result: MtlsTransport = {
    peerOf(socket) {
      const peer = peerOf(socket);
      return peer ? mtlsPeerOf(peer) : undefined;
    },
  };
  if (listener.publicUrl) result.endpointAliasBase = listener.publicUrl;
  return result;
}
