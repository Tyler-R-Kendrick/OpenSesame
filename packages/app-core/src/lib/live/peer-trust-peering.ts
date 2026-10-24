/**
 * Browser-only live peering trust: enroll local ARK, export a paste/QR signal,
 * admit a remote peer before catalog exchange, and gate approvals in-memory.
 */
import { PeerApprovalQueue } from "../peer-trust/approval-queue.js";
import { ensurePeerArkSigningKey } from "../peer-trust/ark-key.js";
import { ABSENT_DTLS, isDtlsFingerprint } from "../peer-trust/handshake.js";
import {
  humanProofKindAllowsVerb,
  verbRequiresHardwarePasskey,
} from "../peer-trust/human-proof-tier.js";
import { saveOwnerCommitment } from "../peer-trust/peers.js";
import {
  encodePeerTrustSignal,
  signedPeerTrustSignal,
} from "../peer-trust/signaling.js";
import {
  type PeerTrustLoadResult,
  commitPeerTrustEnrollment,
  loadPeerTrustStore,
} from "../peer-trust/store.js";
import {
  type PeerTrustAdmitResult,
  admitPeerTrustSignal,
} from "./peer-trust-admit.js";

export type LivePeerTrustExport =
  | {
      ok: true;
      signal: string;
      sas: string;
      spkiFingerprint: string;
      enrollmentEpoch: number;
    }
  | { ok: false; reason: "ark-unavailable" | "missing-enrollment" };

export type LivePeerTrustGateResult =
  | PeerTrustAdmitResult
  | { ok: false; reason: "local-trust-missing" | "epoch-behind" };

export type LivePeerTrustExportInput = Readonly<{
  rememberedFingerprint?: string;
  /** DTLS fingerprint the owner's certificate will present, or `absent`. */
  ownerDtls?: string;
}>;

/** Load or create local trust and return a signal for the joiner to pass OOB. */
export async function exportLivePeerTrustSignal(
  input: LivePeerTrustExportInput = {},
): Promise<LivePeerTrustExport> {
  const loaded = await loadOrEnroll(input.rememberedFingerprint);
  if (!loaded) return { ok: false, reason: "ark-unavailable" };
  const ark = await ensurePeerArkSigningKey();
  if (!ark) return { ok: false, reason: "ark-unavailable" };
  const ownerDtls =
    input.ownerDtls && isDtlsFingerprint(input.ownerDtls)
      ? input.ownerDtls
      : ABSENT_DTLS;
  const signal = await signedPeerTrustSignal(
    ark.privateKey,
    loaded.envelope,
    ownerDtls,
  );
  if (!signal) return { ok: false, reason: "missing-enrollment" };
  const saved = await saveOwnerCommitment({
    ownerKey: loaded.record.spkiFingerprint,
    ownerNonce: signal.ownerNonce,
    ownerDtls: signal.ownerDtls,
    ownerSpkiB64: loaded.envelope.spkiB64,
    enrollmentEpoch: loaded.record.enrollmentEpoch,
  }).catch(() => false);
  if (!saved) return { ok: false, reason: "ark-unavailable" };
  return {
    ok: true,
    signal: encodePeerTrustSignal(signal),
    sas: loaded.sas,
    spkiFingerprint: loaded.record.spkiFingerprint,
    enrollmentEpoch: loaded.record.enrollmentEpoch,
  };
}

/**
 * Admit a remote trust signal before WebRTC / catalog work. Refuses changed
 * keys when `rememberedFingerprint` is set.
 */
export async function gateLivePeerTrustSignal(
  rawSignal: string,
  rememberedFingerprint?: string,
  minimumEpoch?: number,
): Promise<LivePeerTrustGateResult> {
  const local = await loadPeerTrustStore();
  if (!local.ok && local.reason !== "missing") {
    return { ok: false, reason: "local-trust-missing" };
  }
  const admit = await admitPeerTrustSignal(rawSignal, rememberedFingerprint);
  if (!admit.ok) return admit;
  if (minimumEpoch !== undefined && admit.enrollmentEpoch < minimumEpoch) {
    return { ok: false, reason: "epoch-behind" };
  }
  return admit;
}

export type PeerJoinApproval = Readonly<{
  queue: PeerApprovalQueue;
  /** Queue peer-join approvals. One is approved at a time; none are dropped. */
  requestJoinApproval: (
    peerSessionId: string,
    reference?: string,
  ) => ReturnType<PeerApprovalQueue["ensure"]>;
  /** Human proof tier gate for peer verbs (software passkey only on low-risk). */
  passkeyAllowsVerb: (
    proofKind: "passkey" | "software-passkey",
    verb: string,
  ) => boolean;
}>;

export function createLivePeerJoinApproval(): PeerJoinApproval {
  const queue = new PeerApprovalQueue(Date.now, "queue");
  return {
    queue,
    requestJoinApproval: (peerSessionId, reference) =>
      queue.ensure(peerSessionId, "peer-join", reference),
    passkeyAllowsVerb: (proofKind, verb) => {
      if (
        verbRequiresHardwarePasskey(verb) &&
        proofKind === "software-passkey"
      ) {
        return false;
      }
      return humanProofKindAllowsVerb(proofKind, verb);
    },
  };
}

async function loadOrEnroll(
  rememberedFingerprint: string | undefined,
): Promise<Extract<PeerTrustLoadResult, { ok: true }> | null> {
  const loaded = await loadPeerTrustStore();
  if (loaded.ok) return loaded;
  if (loaded.reason !== "missing") return null;
  const committed = await commitPeerTrustEnrollment(rememberedFingerprint);
  if (!committed.ok) return null;
  return {
    ok: true,
    record: committed.record,
    sas: committed.sas,
    envelope: committed.envelope,
  };
}
