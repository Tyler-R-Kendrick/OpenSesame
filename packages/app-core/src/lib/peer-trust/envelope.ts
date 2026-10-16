import type { PeerTrustRecord } from "./record.js";

import { PEER_TRUST_ENVELOPE_KIND } from "./constants.js";

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
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    peerTrustSignedBytes(unsigned),
  );
  let binary = "";
  for (const byte of new Uint8Array(signature)) {
    binary += String.fromCharCode(byte);
  }
  return { ...unsigned, signatureB64: btoa(binary) };
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
  try {
    const der = Uint8Array.from(atob(envelope.spkiB64), (c) => c.charCodeAt(0));
    const publicKey = await crypto.subtle.importKey(
      "spki",
      der,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signature = Uint8Array.from(atob(envelope.signatureB64), (c) =>
      c.charCodeAt(0),
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      peerTrustSignedBytes({
        schemaVersion: envelope.schemaVersion,
        kind: envelope.kind,
        spkiFingerprint: envelope.spkiFingerprint,
        enrollmentEpoch: envelope.enrollmentEpoch,
        spkiB64: envelope.spkiB64,
      }),
    );
  } catch {
    return false;
  }
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
