/**
 * Browser-local drop claim plane — backend for the device-native Identity
 * host (ADR 0062 + ADR 0118). Pages stores sealed claim digests in origin
 * storage; `device-identity-host` exposes them as `/v1/claims*`. Deliberately
 * does not import `drop.ts` (that module calls into the transport, which
 * calls the identity plane, which calls this store).
 */

import {
  type BoundaryValue,
  type JsonObject,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { bytesToB64url } from "@opensesame/sdk-browser";

const STORAGE_KEY = "opensesame.local-drop-claims.v1";
const PEPPER_KEY = "opensesame.local-drop-pepper.v1";
const MAX_ATTEMPTS = 5;

export class LocalDropClaimError extends Error {
  readonly code: "unreachable" | "refused";
  constructor(code: "unreachable" | "refused", message: string) {
    super(message);
    this.name = "LocalDropClaimError";
    this.code = code;
  }
}

type LocalClaimRecord = {
  id: string;
  tokenDigest: string;
  userCodeDigest: string;
  targetManifest: JsonObject;
  state: "pending" | "presented" | "expired";
  expiresAtMs: number;
  attempts: number;
  version: number;
};

type LocalClaimStore = {
  claims: Record<string, LocalClaimRecord>;
};

export type LocalDropSession = {
  claimId: string;
  bearerToken: string;
  userCode: string;
  verifyUrl: string;
  expiresAt: string;
};

export type LocalDropPollState = "pending" | "consumed" | "expired";

/** In-memory fallback when `localStorage` is unavailable (Vitest node). */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const memoryFallback = new MemoryStorage();

export const localDropClaimSeams = {
  storage(): Storage {
    try {
      const slot = globalThis.localStorage;
      if (slot) {
        slot.setItem("__os_drop_probe__", "1");
        slot.removeItem("__os_drop_probe__");
        return slot;
      }
    } catch {
      /* fall through to memory */
    }
    return memoryFallback;
  },
  claimBase(): string {
    return pagesClaimBase();
  },
};

function storage(): Storage {
  return localDropClaimSeams.storage();
}

function readStore(): LocalClaimStore {
  const raw = storage()?.getItem(STORAGE_KEY);
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

function writeStore(store: LocalClaimStore): void {
  storage().setItem(STORAGE_KEY, JSON.stringify(store));
}

async function devicePepper(): Promise<string> {
  const slot = storage();
  const existing = slot.getItem(PEPPER_KEY);
  if (isString(existing) && existing.length >= 32) return existing;
  const next = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  slot.setItem(PEPPER_KEY, next);
  return next;
}

async function sha256Url(parts: string[]): Promise<string> {
  const joined = new TextEncoder().encode(parts.join("\0"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
  return bytesToB64url(digest);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function mintUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    // SAFETY: bytes[i] is defined for i < length.
    const b = bytes[i] ?? 0;
    out += alphabet[b % alphabet.length] ?? "A";
    if (i === 3) out += "-";
  }
  return out;
}

function freshen(record: LocalClaimRecord, now: number): LocalClaimRecord {
  if (record.state === "pending" && record.expiresAtMs <= now) {
    return { ...record, state: "expired", version: record.version + 1 };
  }
  return record;
}

function toPollState(state: LocalClaimRecord["state"]): LocalDropPollState {
  if (state === "pending") return "pending";
  if (state === "presented") return "consumed";
  return "expired";
}

/** Origin + Vite base, no trailing slash — the Pages claim host. */
export function pagesClaimBase(
  origin = globalThis.location?.origin ?? "",
  base = import.meta.env.BASE_URL || "/",
): string {
  if (!isString(origin) || origin.length === 0) {
    throw new LocalDropClaimError(
      "unreachable",
      "This page has no origin, so a drop link cannot be minted here.",
    );
  }
  try {
    return new URL(base, origin).href.replace(/\/$/, "");
  } catch {
    throw new LocalDropClaimError(
      "unreachable",
      "This page has no origin, so a drop link cannot be minted here.",
    );
  }
}

export async function createLocalDropClaim(
  targetManifest: JsonObject,
  ttlMs: number,
): Promise<LocalDropSession> {
  const pepper = await devicePepper();
  const id = `clm_${bytesToB64url(crypto.getRandomValues(new Uint8Array(16)))}`;
  const secret = bytesToB64url(crypto.getRandomValues(new Uint8Array(24)));
  const bearerToken = `osc_clm_${id}.${secret}`;
  const userCode = mintUserCode();
  const now = Date.now();
  const record: LocalClaimRecord = {
    id,
    tokenDigest: await sha256Url([pepper, "token", bearerToken]),
    userCodeDigest: await sha256Url([pepper, "code", id, userCode]),
    targetManifest: structuredClone(targetManifest),
    state: "pending",
    expiresAtMs: now + Math.max(1_000, ttlMs),
    attempts: 0,
    version: 1,
  };
  const store = readStore();
  store.claims[id] = record;
  writeStore(store);
  return {
    claimId: id,
    bearerToken,
    userCode,
    verifyUrl: `${localDropClaimSeams.claimBase()}/claim`,
    expiresAt: new Date(record.expiresAtMs).toISOString(),
  };
}

export async function pollLocalDropClaim(
  claimId: string,
  bearerToken: string,
): Promise<LocalDropPollState> {
  const pepper = await devicePepper();
  const store = readStore();
  const raw = store.claims[claimId];
  if (!raw) {
    throw new LocalDropClaimError(
      "refused",
      "This drop claim was not found on this device.",
    );
  }
  const record = freshen(raw, Date.now());
  if (record !== raw) {
    store.claims[claimId] = record;
    writeStore(store);
  }
  const digest = await sha256Url([pepper, "token", bearerToken]);
  if (!timingSafeEqual(digest, record.tokenDigest)) {
    throw new LocalDropClaimError(
      "refused",
      "This drop's claim token was refused.",
    );
  }
  return toPollState(record.state);
}

export type PresentedLocalDrop = {
  claimId: string;
  state: LocalDropPollState;
  targetManifest: JsonObject;
};

export async function presentLocalDropClaim(
  bearerToken: string,
  userCode: string,
): Promise<PresentedLocalDrop> {
  const pepper = await devicePepper();
  const parts = bearerToken.split(".");
  if (parts.length !== 2 || !parts[0]?.startsWith("osc_clm_")) {
    throw new LocalDropClaimError(
      "refused",
      "This drop link's claim token is not well formed.",
    );
  }
  const claimId = parts[0].slice("osc_clm_".length);
  if (!claimId) {
    throw new LocalDropClaimError(
      "refused",
      "This drop link's claim token is not well formed.",
    );
  }
  const store = readStore();
  const raw = store.claims[claimId];
  if (!raw) {
    throw new LocalDropClaimError(
      "refused",
      "This drop is not on this device. Open the link in the browser that sealed it, or set an Identity API under Settings for cross-device drops.",
    );
  }
  let record = freshen(raw, Date.now());
  if (record.state === "expired") {
    store.claims[claimId] = record;
    writeStore(store);
    throw new LocalDropClaimError("refused", "This drop has expired.");
  }
  if (record.state === "presented") {
    throw new LocalDropClaimError(
      "refused",
      "This drop was already opened and cannot be opened again.",
    );
  }
  const tokenDigest = await sha256Url([pepper, "token", bearerToken]);
  if (!timingSafeEqual(tokenDigest, record.tokenDigest)) {
    throw new LocalDropClaimError(
      "refused",
      "This drop's claim token was refused.",
    );
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    throw new LocalDropClaimError(
      "refused",
      "Too many wrong codes for this drop. Seal a new one.",
    );
  }
  const codeDigest = await sha256Url([
    pepper,
    "code",
    claimId,
    userCode.trim(),
  ]);
  if (!timingSafeEqual(codeDigest, record.userCodeDigest)) {
    record = {
      ...record,
      attempts: record.attempts + 1,
      version: record.version + 1,
    };
    store.claims[claimId] = record;
    writeStore(store);
    throw new LocalDropClaimError(
      "refused",
      "That code does not match this drop.",
    );
  }
  record = {
    ...record,
    state: "presented",
    attempts: 0,
    version: record.version + 1,
  };
  store.claims[claimId] = record;
  writeStore(store);
  return {
    claimId,
    state: toPollState(record.state),
    targetManifest: record.targetManifest,
  };
}

/** Test seam — wipe local drop claims and pepper. */
export function resetLocalDropClaimsForTests(): void {
  storage().removeItem(STORAGE_KEY);
  storage().removeItem(PEPPER_KEY);
  memoryFallback.clear();
}
