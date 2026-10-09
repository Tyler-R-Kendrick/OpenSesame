/**
 * Browser-local drop claim plane — backend for the device-native Identity
 * host (ADR 0062 + ADR 0118). Claim digests and the device pepper live in
 * the OPFS kv, never localStorage. `device-identity-host` exposes them as
 * `/v1/claims*`. Deliberately does not import `drop.ts`.
 */

import { ceremonyPath } from "@opensesame/ceremony-kit";
import {
  type BoundaryValue,
  type JsonObject,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { bytesToB64url } from "@opensesame/sdk-browser";
import { env } from "../../host.js";
import { type WebStorage, maybePage } from "../../ports.js";
import { noteDropLockedOut, noteDropOpened } from "../sharing-receipts.js";
import {
  claimIdFromBearer,
  mintUserCode,
  sha256Url,
  timingSafeEqual,
} from "./local-drop-codec.js";
import { originKvSlot } from "./origin-kv-slot.js";

const STORAGE_KEY = "opensesame.local-drop-claims.v1";
const PEPPER_KEY = "opensesame.local-drop-pepper.v1";

/**
 * The plaintext kv keys this plane reads synchronously. `sharing.drops`
 * hydrates them in `activate`; the core boot does not (ownership.md §4.3),
 * so nothing about drops is pulled into an installation that has none.
 */
export const LOCAL_DROP_CLAIM_STORAGE_KEY = STORAGE_KEY;

export const LOCAL_DROP_CLAIM_KEYS: readonly string[] = [
  STORAGE_KEY,
  PEPPER_KEY,
];
const MAX_ATTEMPTS = 5;

function wrongCodeWords(triesLeft: number): string {
  const base = "That code does not match this drop.";
  if (triesLeft > 1) return `${base} ${triesLeft} tries left.`;
  if (triesLeft === 1) return `${base} This is your last try.`;
  return `${base} No tries left.`;
}

export class LocalDropClaimError extends Error {
  readonly code: "unreachable" | "refused";
  /**
   * The Identity API's error code for the same refusal, so a drop opened on
   * this device is read by the one wording (ceremony-kit `dropRefusal`).
   */
  readonly wire: string;
  constructor(
    code: "unreachable" | "refused",
    message: string,
    wire: string = code,
    readonly attemptsLeft?: number,
  ) {
    super(message);
    this.name = "LocalDropClaimError";
    this.code = code;
    this.wire = wire;
  }
}

type LocalClaimRecord = {
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

export type LocalDropSession = {
  claimId: string;
  bearerToken: string;
  userCode: string;
  verifyUrl: string;
  expiresAt: string;
};

export type LocalDropPollState = "pending" | "consumed" | "expired" | "revoked";

/** What a sender's revoke did to the claim on this device. */
export type LocalDropRevocation = "revoked" | "already_consumed" | "missing";

const claimSlot = originKvSlot([STORAGE_KEY, PEPPER_KEY]);

export const localDropClaimSeams = {
  storage(): WebStorage {
    return claimSlot.storage;
  },
  claimBase(): string {
    return pagesClaimBase();
  },
};

function storage(): WebStorage {
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
function freshen(record: LocalClaimRecord, now: number): LocalClaimRecord {
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

/** Wipe ciphertext on claims that can no longer be opened. */
export function disposeExpiredLocalDropClaims(now = Date.now()): void {
  const store = readStore();
  let changed = false;
  for (const [id, raw] of Object.entries(store.claims)) {
    const next = freshen(raw, now);
    if (next === raw) continue;
    store.claims[id] = next;
    changed = true;
  }
  if (changed) writeStore(store);
}

function toPollState(state: LocalClaimRecord["state"]): LocalDropPollState {
  if (state === "pending") return "pending";
  if (state === "presented") return "consumed";
  if (state === "revoked") return "revoked";
  return "expired";
}

/** Origin + Vite base, no trailing slash — the Pages claim host. */
export function pagesClaimBase(
  origin = maybePage()?.location.origin ?? "",
  base = env().BASE_URL || "/",
): string {
  const noOrigin = () =>
    new LocalDropClaimError(
      "unreachable",
      "This page has no origin, so a drop link cannot be minted here.",
    );
  if (!isString(origin) || origin.length === 0) throw noOrigin();
  try {
    return new URL(base, origin).href.replace(/\/$/, "");
  } catch {
    throw noOrigin();
  }
}

/**
 * The `/claim` route under a claim host (`spec/config/ceremony-routes.json`):
 * the one spelling of a drop's link, whoever minted its claim.
 */
export function pagesClaimUrl(base = pagesClaimBase()): string {
  return `${base}${ceremonyPath("claim")}`;
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
    verifyUrl: pagesClaimUrl(localDropClaimSeams.claimBase()),
    expiresAt: new Date(record.expiresAtMs).toISOString(),
  };
}

export async function pollLocalDropClaim(
  claimId: string,
  bearerToken: string,
): Promise<LocalDropPollState> {
  const pepper = await devicePepper();
  const digest = await sha256Url([pepper, "token", bearerToken]);
  const store = readStore();
  const raw = store.claims[claimId];
  if (!raw) {
    throw new LocalDropClaimError(
      "refused",
      "This drop claim was not found on this device.",
    );
  }
  const record = freshen(raw, Date.now());
  if (!timingSafeEqual(digest, record.tokenDigest)) {
    throw new LocalDropClaimError(
      "refused",
      "This drop's claim token was refused.",
    );
  }
  if (record !== raw) {
    store.claims[claimId] = record;
    writeStore(store);
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
  const refuse = (wire: string, message: string, attemptsLeft?: number) =>
    new LocalDropClaimError("refused", message, wire, attemptsLeft);
  const malformed = "This drop link's claim token is not well formed.";
  const claimId = claimIdFromBearer(bearerToken);
  if (!claimId) throw refuse("invalid_token", malformed);
  const pepper = await devicePepper();
  const tokenDigest = await sha256Url([pepper, "token", bearerToken]);
  const codeDigest = await sha256Url([
    pepper,
    "code",
    claimId,
    userCode.trim(),
  ]);
  // Digests are done. Read and write with no await between them, so a revoke
  // cannot land in the middle and have this present put the ciphertext back.
  const store = readStore();
  const raw = store.claims[claimId];
  if (!raw) {
    throw refuse(
      "not_found",
      "This drop is not on this device. Open the link in the browser that sealed it, or connect a sign-in service for cross-device drops.",
    );
  }
  const record = freshen(raw, Date.now());
  const persist = (next: LocalClaimRecord) => {
    store.claims[claimId] = next;
    writeStore(store);
  };
  if (record.state !== "pending") {
    if (record !== raw) persist(record);
    if (record.state === "revoked") {
      throw refuse("REVOKED", "This drop was revoked.");
    }
    if (record.state === "expired") {
      throw refuse("EXPIRED", "This drop has expired.");
    }
    throw refuse(
      "INVALID_TRANSITION",
      "This drop was already opened and cannot be opened again.",
    );
  }
  if (!timingSafeEqual(tokenDigest, record.tokenDigest)) {
    throw refuse("invalid_token", "This drop's claim token was refused.");
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    throw refuse(
      "too_many_attempts",
      "Too many wrong codes for this drop. Seal a new one.",
    );
  }
  if (!timingSafeEqual(codeDigest, record.userCodeDigest)) {
    const attempts = record.attempts + 1;
    const triesLeft = MAX_ATTEMPTS - attempts;
    persist({ ...record, attempts, version: record.version + 1 });
    if (attempts >= MAX_ATTEMPTS) noteDropLockedOut(claimId);
    throw refuse("invalid_user_code", wrongCodeWords(triesLeft), triesLeft);
  }
  const targetManifest = structuredClone(record.targetManifest);
  persist({
    ...record,
    state: "presented",
    targetManifest: {},
    attempts: 0,
    version: record.version + 1,
  });
  noteDropOpened(claimId);
  return {
    claimId,
    state: "consumed",
    targetManifest,
  };
}

/**
 * Kill a pending claim and wipe its ciphertext. An already-opened claim stays
 * consumed (the secret already left) and only loses leftover ciphertext. A
 * claim this device does not hold is `missing` — callers must not treat that
 * as a revoke, because the sealing device may still have it. A wrong bearer
 * throws and changes nothing.
 */
export async function revokeLocalDropClaim(
  claimId: string,
  bearerToken: string,
): Promise<LocalDropRevocation> {
  const pepper = await devicePepper();
  const digest = await sha256Url([pepper, "token", bearerToken]);
  const store = readStore();
  const raw = store.claims[claimId];
  if (!raw) return "missing";
  const record = freshen(raw, Date.now());
  if (!timingSafeEqual(digest, record.tokenDigest)) {
    throw new LocalDropClaimError(
      "refused",
      "This drop's claim token was refused.",
    );
  }
  if (record.state === "presented") {
    if (record !== raw) {
      store.claims[claimId] = record;
      writeStore(store);
    }
    return "already_consumed";
  }
  const next: LocalClaimRecord = {
    ...record,
    state: "revoked",
    targetManifest: {},
    version: record.version + 1,
  };
  store.claims[claimId] = next;
  writeStore(store);
  return "revoked";
}

/** Test seam — wipe local drop claims and pepper. */
export function resetLocalDropClaimsForTests(): void {
  claimSlot.reset();
}
