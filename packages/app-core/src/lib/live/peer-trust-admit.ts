/**
 * Browser-only peering trust gate: verify a QR / pasted trust signal before
 * WebRTC catalog exchange. No host, daemon, or CLI on this path.
 */
import { compareRootTrustFingerprint } from "../peer-trust/alarm.js";
import {
  decodePeerTrustSignal,
  verifyPeerTrustSignal,
} from "../peer-trust/signaling.js";

export type PeerTrustAdmitResult =
  | {
      ok: true;
      spkiFingerprint: string;
      enrollmentEpoch: number;
      ownerDtls: string;
      ownerNonce: string;
      ownerSpkiB64: string;
    }
  | {
      ok: false;
      reason:
        | "invalid-signal"
        | "invalid-signature"
        | "changed-key"
        | "missing-signal";
      alarm?: ReturnType<typeof compareRootTrustFingerprint>;
    };

export async function admitPeerTrustSignal(
  rawSignal: string,
  rememberedFingerprint?: string,
): Promise<PeerTrustAdmitResult> {
  if (rawSignal.trim().length === 0) {
    return { ok: false, reason: "missing-signal" };
  }
  const signal = decodePeerTrustSignal(rawSignal);
  if (!signal) return { ok: false, reason: "invalid-signal" };
  const valid = await verifyPeerTrustSignal(signal);
  if (!valid) return { ok: false, reason: "invalid-signature" };
  const alarm = compareRootTrustFingerprint(
    rememberedFingerprint,
    signal.envelope.spkiFingerprint,
  );
  if (alarm.kind === "changed") {
    return { ok: false, reason: "changed-key", alarm };
  }
  return {
    ok: true,
    spkiFingerprint: signal.envelope.spkiFingerprint,
    enrollmentEpoch: signal.envelope.enrollmentEpoch,
    ownerDtls: signal.ownerDtls,
    ownerNonce: signal.ownerNonce,
    ownerSpkiB64: signal.envelope.spkiB64,
  };
}
