import type { BoundaryValue } from "@opensesame/os-domain";
/**
 * Manual / QR signaling payload for PWA-to-PWA peering (WebRTC offer path).
 * The owner signs the session introduction (key, DTLS commitment, nonce).
 * The session SAS is not in this payload: both sides derive it from the handshake.
 */
import { verifyPeerTrustEnvelope } from "./envelope.js";
import type { SignedPeerTrustEnvelope } from "./envelope.js";
import { fingerprintOfSpkiB64 } from "./fingerprint.js";
import {
  type OwnerIntro,
  type OwnerIntroFields,
  isDtlsFingerprint,
  isNonce,
  isSigB64,
  randomNonce,
  signOwnerIntro,
  verifyOwnerIntro,
} from "./handshake.js";
import { parsePeerTrustSignal } from "./parse.js";

import { PEER_TRUST_SIGNAL_KIND } from "./constants.js";

export { PEER_TRUST_SIGNAL_KIND };

export type PeerTrustSignal = Readonly<{
  kind: typeof PEER_TRUST_SIGNAL_KIND;
  envelope: SignedPeerTrustEnvelope;
  ownerNonce: string;
  ownerDtls: string;
  introSignatureB64: string;
}>;

export function buildPeerTrustSignal(
  envelope: SignedPeerTrustEnvelope,
  intro: OwnerIntro,
): PeerTrustSignal | null {
  if (
    !isNonce(intro.ownerNonce) ||
    !isDtlsFingerprint(intro.ownerDtls) ||
    !isSigB64(intro.introSignatureB64)
  ) {
    return null;
  }
  return {
    kind: PEER_TRUST_SIGNAL_KIND,
    envelope,
    ownerNonce: intro.ownerNonce,
    ownerDtls: intro.ownerDtls,
    introSignatureB64: intro.introSignatureB64,
  };
}

/** Sign a fresh owner introduction and wrap the enrolled envelope. */
export async function signedPeerTrustSignal(
  privateKey: CryptoKey,
  envelope: SignedPeerTrustEnvelope,
  ownerDtls: string,
): Promise<PeerTrustSignal | null> {
  if (!isDtlsFingerprint(ownerDtls)) return null;
  const fields: OwnerIntroFields = {
    enrollmentEpoch: envelope.enrollmentEpoch,
    ownerDtls,
    ownerKey: envelope.spkiFingerprint,
    ownerNonce: randomNonce(),
  };
  const intro = await signOwnerIntro(privateKey, fields);
  if (!intro) return null;
  return buildPeerTrustSignal(envelope, intro);
}

export async function verifyPeerTrustSignal(
  signal: PeerTrustSignal,
): Promise<boolean> {
  if (signal.kind !== PEER_TRUST_SIGNAL_KIND) return false;
  const fingerprint = await fingerprintOfSpkiB64(signal.envelope.spkiB64);
  if (fingerprint !== signal.envelope.spkiFingerprint) return false;
  const envelopeOk = await verifyPeerTrustEnvelope(signal.envelope);
  if (!envelopeOk) return false;
  return verifyOwnerIntro(
    signal.envelope.spkiB64,
    {
      enrollmentEpoch: signal.envelope.enrollmentEpoch,
      ownerDtls: signal.ownerDtls,
      ownerKey: signal.envelope.spkiFingerprint,
      ownerNonce: signal.ownerNonce,
    },
    signal.introSignatureB64,
  );
}

/** Compact JSON for pasting or encoding in a QR code beside a WebRTC offer. */
export function encodePeerTrustSignal(signal: PeerTrustSignal): string {
  return JSON.stringify(signal);
}

export function decodePeerTrustSignal(raw: string): PeerTrustSignal | null {
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    return parsePeerTrustSignal(parsed);
  } catch {
    return null;
  }
}
