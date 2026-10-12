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
import type { WebStorage } from "../../ports.js";
import { sha256Url } from "./local-drop-codec.js";
import { originKvSlot } from "./origin-kv-slot.js";

export const LOCAL_DROP_CLAIM_STORAGE_KEY = "opensesame.local-drop-claims.v1";
const PEPPER_KEY = "opensesame.local-drop-pepper.v1";

export const LOCAL_DROP_CLAIM_KEYS: readonly string[] = [
  LOCAL_DROP_CLAIM_STORAGE_KEY,
  PEPPER_KEY,
];

export const MAX_DROP_CLAIM_ATTEMPTS = 5;

export type LocalClaimRecord = {
  id: string;
  tokenDigest: string;
  userCodeDigest: string;
  targetManifest: JsonObject;
  state: "pending" | "presented" | "expired" | "revoked";
  expiresAtMs: number;
  attempts: number;
  version: number;
};

type LocalClaimStore = {
  claims: Record<string, LocalClaimRecord>;
};

export type LocalDropPollState = "pending" | "consumed" | "expired" | "revoked";

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

export async function localDropDevicePepper(): Promise<string> {
  const slot = localDropClaimStorage();
  const existing = slot.getItem(PEPPER_KEY);
  if (isString(existing) && existing.length >= 32) return existing;
  const next = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  slot.setItem(PEPPER_KEY, next);
  return next;
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
