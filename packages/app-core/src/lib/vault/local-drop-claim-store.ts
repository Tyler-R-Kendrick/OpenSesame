/**
 * Persistence and record lifecycle for browser-local drop claims.
 * Split from `local-drop-claims.ts` so that file stays inside the size budget.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { bytesToB64url } from "@opensesame/sdk-browser";
import { type WebStorage, lockManager } from "../../ports.js";
import { kvDurability, kvRefresh, kvSetDurable } from "../kv.js";
import { sha256Url } from "./local-drop-codec.js";
import { originKvSlot } from "./origin-kv-slot.js";

export const LOCAL_DROP_CLAIM_STORAGE_KEY = "opensesame.local-drop-claims.v1";
const PEPPER_KEY = "opensesame.local-drop-pepper.v1";

export const LOCAL_DROP_CLAIM_KEYS: readonly string[] = [
  LOCAL_DROP_CLAIM_STORAGE_KEY,
  PEPPER_KEY,
];

export const MAX_DROP_CLAIM_ATTEMPTS = 5;
export const DROP_LOCKOUT_WORDS =
  "Locked out. Too many wrong codes — ask the sender for a fresh drop.";

export type LocalClaimRecord = {
  id: string;
  tokenDigest: string;
  userCodeDigest: string;
  targetManifest: JsonObject;
  state: "pending" | "presented" | "expired" | "revoked" | "locked_out";
  expiresAtMs: number;
  attempts: number;
  version: number;
};

type LocalClaimStore = {
  claims: Record<string, LocalClaimRecord>;
};

export type LocalDropPollState =
  | "pending"
  | "consumed"
  | "expired"
  | "revoked"
  | "locked_out";

const claimSlot = originKvSlot(LOCAL_DROP_CLAIM_KEYS);

export function localDropClaimStorage(): WebStorage {
  return claimSlot.storage;
}

export function resetLocalDropClaimSlotForTests(): void {
  claimSlot.reset();
}

export function wrongDropCodeWords(triesLeft: number): string {
  const base = "That code does not match this drop.";
  if (triesLeft > 1) return `${base} ${triesLeft} tries left.`;
  if (triesLeft === 1) return `${base} This is your last try.`;
  return `${base} No tries left.`;
}

export function readLocalDropClaimStore(): LocalClaimStore {
  const raw = localDropClaimStorage()?.getItem(LOCAL_DROP_CLAIM_STORAGE_KEY);
  if (!raw) return { claims: {} };
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (parsed === null || !isTypeofObject(parsed) || Array.isArray(parsed)) {
      return { claims: {} };
    }
    const claims: BoundaryValue =
      overlapCast<Record<string, BoundaryValue>>(parsed).claims;
    if (!isTypeofObject(claims) || Array.isArray(claims)) return { claims: {} };
    return { claims: overlapCast(claims) };
  } catch {
    return { claims: {} };
  }
}

export function writeLocalDropClaimStore(store: LocalClaimStore): void {
  localDropClaimStorage().setItem(
    LOCAL_DROP_CLAIM_STORAGE_KEY,
    JSON.stringify(store),
  );
}

export type LocalClaimChange<T> = { value: T; changed: boolean };

const CLAIM_LOCK = "opensesame.local-drop-claims.v1";
const CLAIM_STORE_BYTES = 4 * 1024 * 1024;

/**
 * Read-modify-write a claim record under one origin-wide Web Lock and persist
 * durably before returning. `kvGet` is only this tab's cache: without the
 * refresh a second tab's `presented`/`revoked` record never reaches this one,
 * and an older tab's whole-store write can undo it.
 */
export async function updateLocalDropClaimStore<T>(
  change: (store: LocalClaimStore) => LocalClaimChange<T>,
): Promise<T> {
  const run = async (): Promise<T> => {
    await kvRefresh(LOCAL_DROP_CLAIM_STORAGE_KEY, CLAIM_STORE_BYTES);
    const store = readLocalDropClaimStore();
    const result = change(store);
    if (result.changed)
      await kvSetDurable(LOCAL_DROP_CLAIM_STORAGE_KEY, JSON.stringify(store));
    return result.value;
  };
  const locks = lockManager();
  if (locks) return locks.request(CLAIM_LOCK, run);
  if (kvDurability() === "persistent")
    throw new Error("Web Locks are required for shared drop-claim writes.");
  return run();
}

export async function localDropDevicePepper(): Promise<string> {
  const slot = localDropClaimStorage();
  const read = (): string | null => {
    const existing = slot.getItem(PEPPER_KEY);
    return isString(existing) && existing.length >= 32 ? existing : null;
  };
  const existing = read();
  if (existing) return existing;
  // Two tabs opening their first drop at once must not each mint a different
  // pepper: the loser's token digest would never verify. Re-read under the
  // origin-wide lock before creating one.
  const locks = lockManager();
  const create = async (): Promise<string> => {
    await kvRefresh(PEPPER_KEY, 64 * 1024);
    const raced = read();
    if (raced) return raced;
    const next = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
    slot.setItem(PEPPER_KEY, next);
    return next;
  };
  return locks
    ? locks.request("opensesame.local-drop-pepper", create)
    : create();
}

function manifestNeedsWipe(record: LocalClaimRecord): boolean {
  const manifest = record.targetManifest;
  if (!isTypeofObject(manifest) || Array.isArray(manifest)) return true;
  return Object.keys(manifest).length > 0;
}

/**
 * A lapsed pending claim, and any terminal claim still holding a manifest,
 * drops the ciphertext. The same object comes back when nothing changed, so
 * callers can persist only a real edit.
 */
export function freshenLocalDropClaim(
  record: LocalClaimRecord,
  now: number,
): LocalClaimRecord {
  const lapsed = record.state === "pending" && record.expiresAtMs <= now;
  if (!lapsed && (record.state === "pending" || !manifestNeedsWipe(record))) {
    return record;
  }
  return {
    ...record,
    state: lapsed ? "expired" : record.state,
    targetManifest: {},
    version: record.version + 1,
  };
}

export function localDropPollState(
  state: LocalClaimRecord["state"],
): LocalDropPollState {
  if (state === "pending") return "pending";
  if (state === "presented") return "consumed";
  if (state === "revoked") return "revoked";
  if (state === "locked_out") return "locked_out";
  return "expired";
}

export async function digestDropBearerToken(
  pepper: string,
  bearerToken: string,
): Promise<string> {
  return sha256Url([pepper, "token", bearerToken]);
}

export async function digestDropUserCode(
  pepper: string,
  claimId: string,
  userCode: string,
): Promise<string> {
  return sha256Url([pepper, "code", claimId, userCode.trim()]);
}
