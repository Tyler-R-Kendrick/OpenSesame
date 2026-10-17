import type { PeerTrustRecord } from "./record.js";

import { PEER_TRUST_ENVELOPE_KIND } from "./constants.js";
import { signP256, verifyP256 } from "./webcrypto.js";

export { PEER_TRUST_ENVELOPE_KIND };

export type SignedPeerTrustEnvelope = Readonly<{
  schemaVersion: 1;
  kind: typeof PEER_TRUST_ENVELOPE_KIND;
  spkiFingerprint: string;
  enrollmentEpoch: number;
  spkiB64: string;
  signatureB64: string;
}>;

export function peerTrustSignedBytes(
  header: Omit<SignedPeerTrustEnvelope, "signatureB64">,
): Uint8Array {
  const canonical = JSON.stringify({
    enrollmentEpoch: header.enrollmentEpoch,
    kind: header.kind,
    schemaVersion: header.schemaVersion,
    spkiB64: header.spkiB64,
    spkiFingerprint: header.spkiFingerprint,
  });
  return new TextEncoder().encode(canonical);
}

export async function signPeerTrustEnvelope(
  privateKey: CryptoKey,
  record: PeerTrustRecord,
  spkiB64: string,
): Promise<SignedPeerTrustEnvelope> {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: PEER_TRUST_ENVELOPE_KIND,
    spkiFingerprint: record.spkiFingerprint,
    enrollmentEpoch: record.enrollmentEpoch,
    spkiB64,
  };
  const signatureB64 = await signP256(
    privateKey,
    peerTrustSignedBytes(unsigned),
  );
  if (!signatureB64) throw new Error("peer_trust_sign");
  return { ...unsigned, signatureB64 };
}

export async function verifyPeerTrustEnvelope(
  envelope: SignedPeerTrustEnvelope,
): Promise<boolean> {
  if (
    envelope.schemaVersion !== 1 ||
    envelope.kind !== PEER_TRUST_ENVELOPE_KIND
  ) {
    return false;
  }
  if (envelope.enrollmentEpoch < 1) return false;
  return verifyP256(
    envelope.spkiB64,
    envelope.signatureB64,
    peerTrustSignedBytes({
      schemaVersion: envelope.schemaVersion,
      kind: envelope.kind,
      spkiFingerprint: envelope.spkiFingerprint,
      enrollmentEpoch: envelope.enrollmentEpoch,
      spkiB64: envelope.spkiB64,
    }),
  );
}

export function recordFromEnvelope(
  envelope: SignedPeerTrustEnvelope,
): PeerTrustRecord | null {
  if (envelope.enrollmentEpoch < 1) return null;
  return {
    spkiFingerprint: envelope.spkiFingerprint,
    enrollmentEpoch: envelope.enrollmentEpoch,
  };
}
