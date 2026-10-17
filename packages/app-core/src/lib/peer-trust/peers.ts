/**
 * Remembered peer keys and the owner's current handshake commitment.
 * Rows live in the existing peer-trust store (version 1); no second database.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { openPeerTrustDb as openDb, idbRequest as request } from "./db.js";
import {
  isDtlsFingerprint,
  isFingerprint,
  isNonce,
  isSpkiB64,
} from "./handshake.js";
import { parseOwnerCommitment, parseRememberedPeers } from "./parse.js";
import { decodePeerTrustSignal } from "./signaling.js";

const STORE = "trust";
const PEERS = "peers";
const COMMITMENT = "commitment";
const MAX_PEERS = 32;

export type RememberedPeer = Readonly<{
  fingerprint: string;
  epoch: number;
}>;

export type OwnerCommitment = Readonly<{
  ownerKey: string;
  ownerNonce: string;
  ownerDtls: string;
  ownerSpkiB64: string;
  enrollmentEpoch: number;
}>;

export type PeerPin =
  | { kind: "none" }
  | { kind: "known"; fingerprint: string; epoch: number }
  | { kind: "mismatch"; fingerprint: string; epoch: number };

export function readSignalIdentity(
  raw: string,
): { fingerprint: string; epoch: number } | null {
  const signal = decodePeerTrustSignal(raw);
  if (!signal) return null;
  return {
    fingerprint: signal.envelope.spkiFingerprint,
    epoch: signal.envelope.enrollmentEpoch,
  };
}

export async function listRememberedPeers(): Promise<RememberedPeer[]> {
  const db = await openDb();
  try {
    const found: BoundaryValue = await request(
      db.transaction(STORE, "readonly").objectStore(STORE).get(PEERS),
    );
    return parseRememberedPeers(found);
  } finally {
    db.close();
  }
}

export async function rememberTrustedPeer(
  peer: RememberedPeer,
): Promise<boolean> {
  if (!peerOk(peer)) return false;
  const existing = await listRememberedPeers();
  const db = await openDb();
  try {
    const row = { id: PEERS, peers: mergePeer(existing, peer) };
    await request(
      db.transaction(STORE, "readwrite").objectStore(STORE).put(row),
    );
    return true;
  } finally {
    db.close();
  }
}

/**
 * The pin to hand `joinLive`. A stored match carries its epoch. Exactly one
 * stored peer that does not match is a changed-key alarm. Several stored
 * peers and a new fingerprint is a new peer, not an alarm.
 */
export async function rememberedPeerPin(fingerprint: string): Promise<PeerPin> {
  const peers = await listRememberedPeers();
  const known = peers.find((row) => row.fingerprint === fingerprint);
  if (known) {
    return {
      kind: "known",
      fingerprint: known.fingerprint,
      epoch: known.epoch,
    };
  }
  if (peers.length !== 1) return { kind: "none" };
  const only = peers[0];
  if (!only) return { kind: "none" };
  return { kind: "mismatch", fingerprint: only.fingerprint, epoch: only.epoch };
}

export async function saveOwnerCommitment(
  commitment: OwnerCommitment,
): Promise<boolean> {
  if (!commitmentOk(commitment)) return false;
  const db = await openDb();
  try {
    await request(
      db
        .transaction(STORE, "readwrite")
        .objectStore(STORE)
        .put({ id: COMMITMENT, ...commitment }),
    );
    return true;
  } finally {
    db.close();
  }
}

export async function loadOwnerCommitment(): Promise<OwnerCommitment | null> {
  const db = await openDb();
  try {
    const found: BoundaryValue = await request(
      db.transaction(STORE, "readonly").objectStore(STORE).get(COMMITMENT),
    );
    return parseOwnerCommitment(found);
  } finally {
    db.close();
  }
}

function peerOk(peer: RememberedPeer): boolean {
  return isFingerprint(peer.fingerprint) && peer.epoch >= 1;
}

function mergePeer(
  peers: RememberedPeer[],
  peer: RememberedPeer,
): RememberedPeer[] {
  const bumped = peers.some((row) => row.fingerprint === peer.fingerprint);
  const next = peers.map((row) =>
    row.fingerprint === peer.fingerprint
      ? { fingerprint: row.fingerprint, epoch: Math.max(row.epoch, peer.epoch) }
      : row,
  );
  if (!bumped) next.push({ fingerprint: peer.fingerprint, epoch: peer.epoch });
  return next.length > MAX_PEERS ? next.slice(next.length - MAX_PEERS) : next;
}

function commitmentOk(commitment: OwnerCommitment): boolean {
  return (
    isFingerprint(commitment.ownerKey) &&
    isNonce(commitment.ownerNonce) &&
    isDtlsFingerprint(commitment.ownerDtls) &&
    isSpkiB64(commitment.ownerSpkiB64) &&
    commitment.enrollmentEpoch >= 1
  );
}
