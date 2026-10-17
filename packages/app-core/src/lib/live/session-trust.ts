/**
 * What `joinLive` must know before it dials: a verified signal, an explicit
 * unverified manual join, or a refusal. An empty signal does not skip the gate.
 */
import {
  type PeerArkSigningKey,
  ensurePeerArkSigningKey,
} from "../peer-trust/ark-key.js";
import { ABSENT_DTLS, UNVERIFIED_OWNER_KEY } from "../peer-trust/handshake.js";
import { loadPeerTrustStore } from "../peer-trust/store.js";
import type { JoinPeerMaterial } from "./peer-trust-join.js";
import { gateLivePeerTrustSignal } from "./peer-trust-peering.js";

export type PrepareJoinInput = Readonly<{
  peerTrustSignal?: string | null | undefined;
  rememberedPeerFingerprint?: string | undefined;
  minimumPeerTrustEpoch?: number | undefined;
  unverifiedManual?: boolean | undefined;
}>;

export type PrepareJoinResult =
  | { ok: true; material: JoinPeerMaterial | null }
  | { ok: false; reason: string };

export async function prepareJoinTrust(
  input: PrepareJoinInput,
): Promise<PrepareJoinResult> {
  const signal = input.peerTrustSignal?.trim() ?? "";
  if (signal.length > 0) return prepareVerified(input, signal);
  if (input.unverifiedManual === true) return prepareUnverified();
  return { ok: false, reason: "missing-signal" };
}

async function prepareVerified(
  input: PrepareJoinInput,
  signal: string,
): Promise<PrepareJoinResult> {
  const trust = await gateLivePeerTrustSignal(
    signal,
    input.rememberedPeerFingerprint,
    input.minimumPeerTrustEpoch,
  );
  if (!trust.ok) return { ok: false, reason: trust.reason };
  const ark = await loadArk();
  if (!ark) return { ok: false, reason: "ark-unavailable" };
  const local = await loadPeerTrustStore().catch(() => null);
  const joinerEpoch = local?.ok ? local.record.enrollmentEpoch : 0;
  return {
    ok: true,
    material: {
      unverified: false,
      ownerKey: trust.spkiFingerprint,
      ownerDtls: trust.ownerDtls,
      ownerNonce: trust.ownerNonce,
      ownerSpkiB64: trust.ownerSpkiB64,
      ownerEpoch: trust.enrollmentEpoch,
      joinerKey: ark.spkiFingerprint,
      joinerSpkiB64: ark.publicSpkiB64,
      joinerEpoch,
      privateKey: ark.privateKey,
    },
  };
}

async function prepareUnverified(): Promise<PrepareJoinResult> {
  const ark = await loadArk();
  if (!ark) return { ok: true, material: null };
  return {
    ok: true,
    material: {
      unverified: true,
      ownerKey: UNVERIFIED_OWNER_KEY,
      ownerDtls: ABSENT_DTLS,
      ownerNonce: "",
      ownerSpkiB64: "",
      ownerEpoch: 0,
      joinerKey: ark.spkiFingerprint,
      joinerSpkiB64: ark.publicSpkiB64,
      joinerEpoch: 0,
      privateKey: ark.privateKey,
    },
  };
}

async function loadArk(): Promise<PeerArkSigningKey | null> {
  try {
    return await ensurePeerArkSigningKey();
  } catch {
    return null;
  }
}
