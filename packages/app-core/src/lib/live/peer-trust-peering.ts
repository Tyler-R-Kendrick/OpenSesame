/**
 * Browser-only live peering trust: enroll local ARK, export a paste/QR signal,
 * admit a remote peer before catalog exchange, and gate approvals in-memory.
 */
import { PeerApprovalQueue } from "../peer-trust/approval-queue.js";
import {
  humanProofKindAllowsVerb,
  verbRequiresHardwarePasskey,
} from "../peer-trust/human-proof-tier.js";
import {
  buildPeerTrustSignal,
  encodePeerTrustSignal,
} from "../peer-trust/signaling.js";
import {
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

/** Load or create local trust and return a signal for the joiner/owner to pass OOB. */
export async function exportLivePeerTrustSignal(
  rememberedFingerprint?: string,
): Promise<LivePeerTrustExport> {
  let loaded = await loadPeerTrustStore();
  if (!loaded.ok) {
    if (loaded.reason !== "missing") {
      return { ok: false, reason: "ark-unavailable" };
    }
    const committed = await commitPeerTrustEnrollment(rememberedFingerprint);
    if (!committed.ok) {
      return { ok: false, reason: "ark-unavailable" };
    }
    loaded = {
      ok: true,
      record: committed.record,
      sas: committed.sas,
      envelope: committed.envelope,
    };
  }
  const signal = buildPeerTrustSignal(loaded.envelope);
  if (!signal) return { ok: false, reason: "missing-enrollment" };
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
  /** Raise at most one pending peer join approval; clears all when ambiguous. */
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
  const queue = new PeerApprovalQueue();
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
