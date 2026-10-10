/**
 * Sender-side drop sends that are not vault items (`shareOnce`, ADR 0062 §2).
 * Sealed in OPFS kv beside the local claim plane so Trash on an item is not
 * the only way to kill a live link.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { activitySeams } from "../activity-log.js";
import { noteDropExpired, noteDropRevoked } from "../sharing-receipts.js";
import {
  LocalDropClaimError,
  type LocalDropRevocation,
  disposeExpiredLocalDropClaims,
  revokeLocalDropClaim,
} from "./local-drop-claims.js";
import { originKvSlot } from "./origin-kv-slot.js";

export const OUTBOUND_DROPS_STORAGE_KEY = "opensesame.outbound-drops.v1";

export type OutboundDropState = "pending" | "consumed" | "expired" | "revoked";

export type OutboundDrop = {
  claimId: string;
  name: string;
  expiresAt: string;
  createdAt: string;
  state: OutboundDropState;
  /** Vault drop record, when the send created one. */
  vaultItemId: string | null;
  /** Source item for a share-once ceremony; not written to the vault. */
  sourceItemId: string | null;
};

type StoredSend = OutboundDrop & {
  bearerToken: string;
  /** Sealing vault; absent on rows written before tomb scoping. */
  tomb?: string;
};

type OutboundDropStore = {
  sends: Record<string, StoredSend>;
};

const slot = originKvSlot([OUTBOUND_DROPS_STORAGE_KEY]);

function readStore(): OutboundDropStore {
  const raw = slot.storage.getItem(OUTBOUND_DROPS_STORAGE_KEY);
  if (!raw) return { sends: {} };
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (parsed === null || !isTypeofObject(parsed) || Array.isArray(parsed)) {
      return { sends: {} };
    }
    const root: JsonObject = overlapCast(parsed);
    const sends = root.sends;
    if (!isJsonObject(sends)) return { sends: {} };
    const kept: Record<string, StoredSend> = {};
    for (const [id, value] of Object.entries(sends)) {
      const row = readSend(value);
      if (row && row.claimId === id) kept[id] = row;
    }
    return { sends: kept };
  } catch {
    return { sends: {} };
  }
}

function readSend(value: BoundaryValue | undefined): StoredSend | null {
  if (!isTypeofObject(value) || Array.isArray(value)) return null;
  const row: JsonObject = overlapCast(value);
  if (
    !isString(row.claimId) ||
    !isString(row.bearerToken) ||
    !isString(row.name) ||
    !isString(row.expiresAt) ||
    !isString(row.createdAt) ||
    !isOutboundState(row.state)
  ) {
    return null;
  }
  const vaultItemId = optionalId(row.vaultItemId);
  const sourceItemId = optionalId(row.sourceItemId);
  if (vaultItemId === undefined || sourceItemId === undefined) return null;
  const send: StoredSend = {
    claimId: row.claimId,
    bearerToken: row.bearerToken,
    name: row.name,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    state: row.state,
    vaultItemId,
    sourceItemId,
  };
  if (row.tomb !== undefined) {
    if (!isString(row.tomb)) return null;
    send.tomb = row.tomb;
  }
  return send;
}

function isOutboundState(
  value: BoundaryValue | undefined,
): value is OutboundDropState {
  return (
    value === "pending" ||
    value === "consumed" ||
    value === "expired" ||
    value === "revoked"
  );
}

function optionalId(
  value: BoundaryValue | undefined,
): string | null | undefined {
  if (value === null) return null;
  if (isString(value)) return value;
  return undefined;
}

function writeStore(store: OutboundDropStore): void {
  slot.storage.setItem(OUTBOUND_DROPS_STORAGE_KEY, JSON.stringify(store));
}

export function recordOutboundDrop(input: {
  claimId: string;
  bearerToken: string;
  name: string;
  expiresAt: string;
  vaultItemId?: string | null;
  sourceItemId?: string | null;
  tomb?: string;
}): void {
  const sealingTomb = input.tomb ?? activitySeams.activeTomb();
  const now = new Date().toISOString();
  const store = readStore();
  const row: StoredSend = {
    claimId: input.claimId,
    bearerToken: input.bearerToken,
    name: input.name.trim() || "Shared item",
    expiresAt: input.expiresAt,
    createdAt: now,
    state: "pending",
    vaultItemId: input.vaultItemId ?? null,
    sourceItemId: input.sourceItemId ?? null,
  };
  if (sealingTomb) row.tomb = sealingTomb;
  store.sends[input.claimId] = row;
  writeStore(store);
}

/**
 * Sender's view of sends. A pending row whose TTL has passed reads as
 * expired, and that same clock wipes claim ciphertext that can no longer
 * be opened.
 */
function syncOutboundDropLedger(now = Date.now()): void {
  disposeExpiredLocalDropClaims(now);
  expireOutboundDrops(now);
}

function rowForList(row: StoredSend, now: number): OutboundDrop {
  const expired = row.state === "pending" && Date.parse(row.expiresAt) <= now;
  const state: OutboundDropState = expired ? "expired" : row.state;
  return {
    claimId: row.claimId,
    name: row.name,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    state,
    vaultItemId: row.vaultItemId,
    sourceItemId: row.sourceItemId,
  };
}

function sendsForTomb(tomb: string, now: number): OutboundDrop[] {
  const store = readStore();
  return Object.values(store.sends)
    .filter((row) => row.tomb === tomb)
    .map((row) => rowForList(row, now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Run expiry receipts and return the sender ledger for the open vault. */
export function refreshOutboundDropLedger(now = Date.now()): OutboundDrop[] {
  syncOutboundDropLedger(now);
  const tomb = activitySeams.activeTomb();
  if (!tomb) return [];
  return sendsForTomb(tomb, now);
}

export function listOutboundDrops(tomb: string, now = Date.now()): OutboundDrop[] {
  syncOutboundDropLedger(now);
  return sendsForTomb(tomb, now);
}

/** Consumed and revoked stick. A later note must not relabel them. */
function patchOpenState(
  claimId: string,
  state: OutboundDropState,
  note: "expired" | "revoked" | null = null,
): void {
  const store = readStore();
  const row = store.sends[claimId];
  if (!row || row.state === state) return;
  if (row.state === "revoked" || row.state === "consumed") return;
  store.sends[claimId] = { ...row, state };
  writeStore(store);
  if (note === "expired") noteDropExpired(claimId);
  if (note === "revoked") noteDropRevoked(claimId);
}

function expireOutboundDrops(now = Date.now()): void {
  for (const row of Object.values(readStore().sends)) {
    if (row.state !== "pending") continue;
    if (Date.parse(row.expiresAt) > now) continue;
    patchOpenState(row.claimId, "expired", "expired");
  }
}

/**
 * Revoke the claim and mark the sender record. Local claim plane only.
 * `missing` with no ledger row means this device never held the claim.
 * `missing` with a row means the ciphertext is already gone here.
 */
/** Revoke from the sender list without handling the bearer in UI. */
export async function revokeOutboundDropById(
  claimId: string,
  tomb: string,
): Promise<LocalDropRevocation> {
  const row = readStore().sends[claimId];
  if (!row || row.tomb !== tomb) return "missing";
  const bearer = row.bearerToken;
  if (!bearer) return "missing";
  return revokeOutboundDrop(claimId, bearer);
}

export async function revokeOutboundDrop(
  claimId: string,
  bearerToken: string,
): Promise<LocalDropRevocation> {
  const outcome = await revokeLocalDropClaim(claimId, bearerToken);
  if (outcome === "already_consumed") {
    patchOpenState(claimId, "consumed");
    return "already_consumed";
  }
  const tracked = readStore().sends[claimId] !== undefined;
  if (tracked) patchOpenState(claimId, "revoked", "revoked");
  if (outcome === "missing") return tracked ? "revoked" : "missing";
  return "revoked";
}

export function noteOutboundDropConsumed(claimId: string): void {
  patchOpenState(claimId, "consumed");
}

/** Revoke when a vault drop record leaves the vault (trash or purge). */
export async function revokeOutboundForVaultItem(
  claimId: string,
  bearerToken: string,
): Promise<LocalDropRevocation> {
  return revokeOutboundDrop(claimId, bearerToken);
}

/** Claim ids whose live send was actually killed on this device. */
export async function revokeOutboundLinkedToItem(
  itemId: string,
): Promise<readonly string[]> {
  const killed: string[] = [];
  for (const row of Object.values(readStore().sends)) {
    if (row.vaultItemId !== itemId && row.sourceItemId !== itemId) continue;
    if (row.state === "revoked" || row.state === "consumed") continue;
    try {
      const outcome = await revokeOutboundDrop(row.claimId, row.bearerToken);
      if (outcome === "revoked") killed.push(row.claimId);
    } catch (error) {
      if (!(error instanceof LocalDropClaimError)) throw error;
    }
  }
  return killed;
}

export function resetOutboundDropsForTests(): void {
  slot.reset();
}

/** Test seam — bearer is never shown in product UI. */
export function outboundDropBearerForTests(claimId: string): string | null {
  return readStore().sends[claimId]?.bearerToken ?? null;
}

export function outboundDropRowStateForTests(
  claimId: string,
): OutboundDropState | null {
  return readStore().sends[claimId]?.state ?? null;
}

/** Test seam — legacy rows without a tomb stay off the ledger but still expire. */
export function seedOutboundDropForTests(row: StoredSend): void {
  const store = readStore();
  store.sends[row.claimId] = row;
  writeStore(store);
}
