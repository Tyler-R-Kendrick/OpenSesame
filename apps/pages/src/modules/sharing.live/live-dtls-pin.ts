/**
 * The owner's DTLS certificate, pinned before the trust signal is exported
 * so the joiner can bind the SAS to the certificate this tab will present.
 */
import {
  ABSENT_DTLS,
  normalizeDtlsFingerprint,
} from "@opensesame/app-core/lib/peer-trust/handshake.js";

type OwnerPin = Readonly<{
  certificate: RTCCertificate;
  dtls: string;
}>;

let pin: OwnerPin | null = null;

export function liveOwnerCertificate(): RTCCertificate | null {
  return pin ? pin.certificate : null;
}

export async function ensureOwnerDtlsPin(): Promise<string> {
  if (pin) return pin.dtls;
  const rtc = globalThis.RTCPeerConnection;
  if (!rtc?.generateCertificate) return ABSENT_DTLS;
  try {
    const algorithm = { name: "ECDSA", namedCurve: "P-256" };
    const certificate = await rtc.generateCertificate(algorithm);
    const dtls = await dtlsOf(certificate);
    pin = { certificate, dtls };
    return dtls;
  } catch {
    return ABSENT_DTLS;
  }
}

async function dtlsOf(certificate: RTCCertificate): Promise<string> {
  const prints = await certificate.getFingerprints();
  for (const print of prints) {
    if (!print.algorithm || !print.value) continue;
    const normalized = normalizeDtlsFingerprint(
      `${print.algorithm} ${print.value}`,
    );
    if (normalized !== ABSENT_DTLS) return normalized;
  }
  return ABSENT_DTLS;
}
