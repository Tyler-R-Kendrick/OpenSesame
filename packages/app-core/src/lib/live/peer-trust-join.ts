/**
 * Seal, judge, and answer the peer-trust half of a live handshake.
 * The PWA does this itself: no daemon, CLI, or relay is on the path.
 */
import { ensurePeerArkSigningKey } from "../peer-trust/ark-key.js";
import { fingerprintOfSpkiB64 } from "../peer-trust/fingerprint.js";
import {
  ABSENT_DTLS,
  type SessionBinding,
  UNVERIFIED_OWNER_KEY,
  answerAgrees,
  bindingValid,
  dtlsFingerprintFromSdp,
  randomNonce,
  sasFromBinding,
  sha256HexOf,
  signBinding,
  verifyBinding,
} from "../peer-trust/handshake.js";
import { loadOwnerCommitment } from "../peer-trust/peers.js";
import type { JoinPeerBlock, ReplyPeerBlock } from "./join-peer.js";
import type { JoinReply, JoinRequest } from "./messages.js";

export type JoinPeerMaterial = Readonly<{
  unverified: boolean;
  ownerKey: string;
  ownerDtls: string;
  ownerNonce: string;
  ownerSpkiB64: string;
  ownerEpoch: number;
  joinerKey: string;
  joinerSpkiB64: string;
  joinerEpoch: number;
  privateKey: CryptoKey;
}>;

export type SeatPeerTrust = Readonly<{
  binding: SessionBinding;
  sas: string;
  unverified: boolean;
  ownerSpkiB64: string;
}>;

export type OpenSeatPin = Readonly<{
  key: string;
  name: string;
  fingerprint: string;
}>;

export type TrustGuestFields = Readonly<{
  sas?: string | undefined;
  unverified?: boolean | undefined;
  keyId?: string | undefined;
  nameClash?: boolean | undefined;
  peerFingerprint?: string | undefined;
  peerEpoch?: number | undefined;
}>;

export type JoinJudgment =
  | { ok: false; reason: "reject" | "duplicate" }
  | {
      ok: true;
      holdReply: boolean;
      peerTrust: SeatPeerTrust | null;
      guest: TrustGuestFields;
      clashKeys: readonly string[];
    };

export type SealedJoin = Readonly<{
  ok: true;
  peer: JoinPeerBlock | undefined;
  sas: string | undefined;
  unverified: boolean;
  binding: SessionBinding | null;
  owner: { fingerprint: string; epoch: number } | null;
}>;

type CheckedPeer = Readonly<{
  sas: string;
  binding: SessionBinding;
  ownerSpkiB64: string;
}>;

export interface DuplicateName {
  readonly duplicate: boolean;
  readonly clashKeys: readonly string[];
}

export function classifyDuplicateName(
  name: string,
  fingerprint: string,
  open: readonly OpenSeatPin[],
): DuplicateName {
  const sameName = open.filter((seat) => seat.name === name);
  const duplicate = sameName.some((seat) => seat.fingerprint === fingerprint);
  if (duplicate) return { duplicate: true, clashKeys: [] };
  return { duplicate: false, clashKeys: sameName.map((seat) => seat.key) };
}

export function joinRequestWithPeer(
  base: JoinRequest,
  peer: JoinPeerBlock | undefined,
): JoinRequest {
  if (!peer) return base;
  return { ...base, peer };
}

/** The waiting-screen status. SAS fields stay off a legacy request. */
export function requestView(
  code: string,
  sas: string | undefined,
  unverified: boolean,
):
  | { at: "request"; code: string }
  | { at: "request"; code: string; sas: string; unverified: boolean } {
  if (!sas) return { at: "request", code };
  return { at: "request", code, sas, unverified };
}

export async function sealRequestPeer(
  material: JoinPeerMaterial | null | undefined,
  offer: string,
): Promise<SealedJoin | { ok: false }> {
  if (!material) {
    return {
      ok: true,
      peer: undefined,
      sas: undefined,
      unverified: false,
      binding: null,
      owner: null,
    };
  }
  const sealed = await sealJoinPeer(material, offer);
  if (!sealed) return { ok: false };
  return sealed;
}

export async function judgeJoinPeer(
  request: JoinRequest,
  joinerPub: string,
  open: readonly OpenSeatPin[],
): Promise<JoinJudgment> {
  if (!request.peer) return judgeLegacy(request, joinerPub, open);
  const checked = await checkPeerBlock(request);
  if (!checked) return { ok: false, reason: "reject" };
  return judgmentFor(request, checked, open);
}

export async function replyForSeat(
  id: string,
  answer: string,
  relay: boolean,
  peerTrust: SeatPeerTrust | null,
): Promise<JoinReply | null> {
  const peer = await replyPeer(answer, peerTrust);
  if (peerTrust && !peer) return null;
  return assembleReply(id, answer, relay, peer);
}

export async function replyHonorsPeer(
  binding: SessionBinding,
  reply: JoinReply,
): Promise<boolean> {
  const peer = reply.peer;
  if (!peer) return false;
  const sas = await sasFromBinding(binding);
  if (!sas || peer.sas !== sas) return false;
  if (!answerAgrees(binding.ownerDtls, reply.answer)) return false;
  if (binding.ownerKey === UNVERIFIED_OWNER_KEY) return true;
  const fingerprint = await fingerprintOfSpkiB64(peer.ownerSpkiB64);
  if (fingerprint !== binding.ownerKey) return false;
  return verifyBinding(peer.ownerSpkiB64, peer.ownerSignatureB64, binding);
}

async function sealJoinPeer(
  material: JoinPeerMaterial,
  offer: string,
): Promise<SealedJoin | null> {
  const binding = bindingFor(material, offer);
  if (!bindingValid(binding)) return null;
  const joinerSignatureB64 = await signBinding(material.privateKey, binding);
  const sas = await sasFromBinding(binding);
  if (!joinerSignatureB64 || !sas) return null;
  return {
    ok: true,
    peer: blockFor(material, binding, joinerSignatureB64),
    sas,
    unverified: material.unverified,
    binding,
    owner: trustedOwner(material),
  };
}

function bindingFor(material: JoinPeerMaterial, offer: string): SessionBinding {
  return {
    ownerKey: material.unverified ? UNVERIFIED_OWNER_KEY : material.ownerKey,
    joinerKey: material.joinerKey,
    ownerDtls: material.unverified ? ABSENT_DTLS : material.ownerDtls,
    joinerDtls: dtlsFingerprintFromSdp(offer),
    ownerNonce: material.unverified ? randomNonce() : material.ownerNonce,
    joinerNonce: randomNonce(),
  };
}

function blockFor(
  material: JoinPeerMaterial,
  binding: SessionBinding,
  joinerSignatureB64: string,
): JoinPeerBlock {
  const block: JoinPeerBlock = {
    joinerKey: binding.joinerKey,
    joinerSpkiB64: material.joinerSpkiB64,
    joinerNonce: binding.joinerNonce,
    joinerDtls: binding.joinerDtls,
    ownerKey: binding.ownerKey,
    ownerNonce: binding.ownerNonce,
    ownerDtls: binding.ownerDtls,
    joinerSignatureB64,
    unverified: material.unverified,
  };
  if (material.joinerEpoch < 1) return block;
  return { ...block, joinerEpoch: material.joinerEpoch };
}

function trustedOwner(
  material: JoinPeerMaterial,
): { fingerprint: string; epoch: number } | null {
  if (material.unverified || material.ownerEpoch < 1) return null;
  return { fingerprint: material.ownerKey, epoch: material.ownerEpoch };
}

async function judgeLegacy(
  request: JoinRequest,
  joinerPub: string,
  open: readonly OpenSeatPin[],
): Promise<JoinJudgment> {
  const fingerprint = await sha256HexOf(joinerPub);
  const names = classifyDuplicateName(request.name, fingerprint, open);
  if (names.duplicate) return { ok: false, reason: "duplicate" };
  return {
    ok: true,
    holdReply: false,
    peerTrust: null,
    clashKeys: names.clashKeys,
    guest: {
      keyId: fingerprint.slice(0, 8),
      nameClash: names.clashKeys.length > 0,
      peerFingerprint: fingerprint,
    },
  };
}

function judgmentFor(
  request: JoinRequest,
  checked: CheckedPeer,
  open: readonly OpenSeatPin[],
): JoinJudgment {
  const block = request.peer;
  if (!block) return { ok: false, reason: "reject" };
  const names = classifyDuplicateName(request.name, block.joinerKey, open);
  if (names.duplicate) return { ok: false, reason: "duplicate" };
  return {
    ok: true,
    holdReply: true,
    peerTrust: {
      binding: checked.binding,
      sas: checked.sas,
      unverified: block.unverified,
      ownerSpkiB64: checked.ownerSpkiB64,
    },
    clashKeys: names.clashKeys,
    guest: {
      sas: checked.sas,
      unverified: block.unverified,
      keyId: block.joinerKey.slice(0, 8),
      nameClash: names.clashKeys.length > 0,
      peerFingerprint: block.joinerKey,
      peerEpoch: block.joinerEpoch,
    },
  };
}

async function checkPeerBlock(
  request: JoinRequest,
): Promise<CheckedPeer | null> {
  const block = request.peer;
  if (!block) return null;
  if (dtlsFingerprintFromSdp(request.offer) !== block.joinerDtls) return null;
  const binding: SessionBinding = {
    ownerKey: block.ownerKey,
    joinerKey: block.joinerKey,
    ownerDtls: block.ownerDtls,
    joinerDtls: block.joinerDtls,
    ownerNonce: block.ownerNonce,
    joinerNonce: block.joinerNonce,
  };
  if (!bindingValid(binding)) return null;
  const joinerKey = await fingerprintOfSpkiB64(block.joinerSpkiB64);
  if (joinerKey !== block.joinerKey) return null;
  const signed = await verifyBinding(
    block.joinerSpkiB64,
    block.joinerSignatureB64,
    binding,
  );
  if (!signed) return null;
  const sas = await sasFromBinding(binding);
  if (!sas) return null;
  if (block.unverified) return unverifiedCheck(block, binding, sas);
  return verifiedCheck(block, binding, sas);
}

function unverifiedCheck(
  block: JoinPeerBlock,
  binding: SessionBinding,
  sas: string,
): CheckedPeer | null {
  if (block.ownerKey !== UNVERIFIED_OWNER_KEY) return null;
  if (block.ownerDtls !== ABSENT_DTLS) return null;
  return { sas, binding, ownerSpkiB64: "" };
}

async function verifiedCheck(
  block: JoinPeerBlock,
  binding: SessionBinding,
  sas: string,
): Promise<CheckedPeer | null> {
  const commitment = await loadOwnerCommitment();
  if (!commitment) return null;
  if (commitment.ownerKey !== block.ownerKey) return null;
  if (commitment.ownerNonce !== block.ownerNonce) return null;
  if (commitment.ownerDtls !== block.ownerDtls) return null;
  return { sas, binding, ownerSpkiB64: commitment.ownerSpkiB64 };
}

async function replyPeer(
  answer: string,
  peerTrust: SeatPeerTrust | null,
): Promise<ReplyPeerBlock | null> {
  if (!peerTrust) return null;
  if (!answerAgrees(peerTrust.binding.ownerDtls, answer)) return null;
  const ark = await ensurePeerArkSigningKey();
  if (!ark) return null;
  if (!peerTrust.unverified && ark.publicSpkiB64 !== peerTrust.ownerSpkiB64) {
    return null;
  }
  const ownerSignatureB64 = await signBinding(
    ark.privateKey,
    peerTrust.binding,
  );
  if (!ownerSignatureB64) return null;
  return {
    sas: peerTrust.sas,
    ownerSignatureB64,
    ownerSpkiB64: ark.publicSpkiB64,
  };
}

function assembleReply(
  id: string,
  answer: string,
  relay: boolean,
  peer: ReplyPeerBlock | null,
): JoinReply {
  if (relay && peer) return { id, answer, relay: "nats", peer };
  if (relay) return { id, answer, relay: "nats" };
  if (peer) return { id, answer, peer };
  return { id, answer };
}
