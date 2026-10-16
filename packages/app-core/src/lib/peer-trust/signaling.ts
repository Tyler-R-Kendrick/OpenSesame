import type { BoundaryValue } from "@opensesame/os-domain";
/**
 * Manual / QR signaling payload for PWA-to-PWA peering (WebRTC offer path).
 * Carries an ARK-signed trust introduction — no host relay required.
 */
import type { SignedPeerTrustEnvelope } from "./envelope.js";
import { verifyPeerTrustEnvelope } from "./envelope.js";
import { parsePeerTrustSignal } from "./parse.js";
import { sasFromFingerprint } from "./sas.js";

import { PEER_TRUST_SIGNAL_KIND } from "./constants.js";

export { PEER_TRUST_SIGNAL_KIND };

export type PeerTrustSignal = Readonly<{
  kind: typeof PEER_TRUST_SIGNAL_KIND;
  envelope: SignedPeerTrustEnvelope;
  sas: string;
}>;

export function buildPeerTrustSignal(
  envelope: SignedPeerTrustEnvelope,
): PeerTrustSignal | null {
  const sas = sasFromFingerprint(envelope.spkiFingerprint);
  if (!sas) return null;
  return { kind: PEER_TRUST_SIGNAL_KIND, envelope, sas };
}

export async function verifyPeerTrustSignal(
  signal: PeerTrustSignal,
): Promise<boolean> {
  if (signal.kind !== PEER_TRUST_SIGNAL_KIND) return false;
  if (signal.sas !== sasFromFingerprint(signal.envelope.spkiFingerprint)) {
    return false;
  }
  return await verifyPeerTrustEnvelope(signal.envelope);
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
