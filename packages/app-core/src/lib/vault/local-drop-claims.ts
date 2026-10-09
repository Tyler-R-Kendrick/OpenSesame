/**
 * Browser-local drop claim plane — backend for the device-native Identity
 * host (ADR 0062 + ADR 0118). Claim digests and the device pepper live in
 * the OPFS kv, never localStorage. `device-identity-host` exposes them as
 * `/v1/claims*`. Deliberately does not import `drop.ts`.
 */

import { ceremonyPath } from "@opensesame/ceremony-kit";
import { type JsonObject, isString } from "@opensesame/os-domain";
import { bytesToB64url } from "@opensesame/sdk-browser";
import { env } from "../../host.js";
import { type WebStorage, maybePage } from "../../ports.js";
import { noteDropLockedOut, noteDropOpened } from "../sharing-receipts.js";
import {
  type LocalDropPollState,
  MAX_DROP_CLAIM_ATTEMPTS,
  digestDropBearerToken,
  digestDropUserCode,
  freshenLocalDropClaim,
  localDropClaimStorage,
  localDropDevicePepper,
  localDropPollState,
  readLocalDropClaimStore,
  resetLocalDropClaimSlotForTests,
  writeLocalDropClaimStore,
  wrongDropCodeWords,
} from "./local-drop-claim-store.js";
import {
  claimIdFromBearer,
  mintUserCode,
  timingSafeEqual,
} from "./local-drop-codec.js";

export {
  LOCAL_DROP_CLAIM_KEYS,
  LOCAL_DROP_CLAIM_STORAGE_KEY,
} from "./local-drop-claim-store.js";

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

export type LocalDropSession = {
  claimId: string;
  bearerToken: string;
  userCode: string;
  verifyUrl: string;
  expiresAt: string;
};

export type { LocalDropPollState };

/** What a sender's revoke did to the claim on this device. */
export type LocalDropRevocation = "revoked" | "already_consumed" | "missing";

export const localDropClaimSeams = {
  storage(): WebStorage {
    return localDropClaimStorage();
  },
  claimBase(): string {
    return pagesClaimBase();
  },
};

/** Wipe ciphertext on claims that can no longer be opened. */
export function disposeExpiredLocalDropClaims(now = Date.now()): void {
  const store = readLocalDropClaimStore();
  let changed = false;
  for (const [id, raw] of Object.entries(store.claims)) {
    const next = freshenLocalDropClaim(raw, now);
    if (next === raw) continue;
    store.claims[id] = next;
    changed = true;
  }
  if (changed) writeLocalDropClaimStore(store);
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
  const pepper = await localDropDevicePepper();
  const id = `clm_${bytesToB64url(crypto.getRandomValues(new Uint8Array(16)))}`;
  const secret = bytesToB64url(crypto.getRandomValues(new Uint8Array(24)));
  const bearerToken = `osc_clm_${id}.${secret}`;
  const userCode = mintUserCode();
  const now = Date.now();
  const record = {
    id,
    tokenDigest: await digestDropBearerToken(pepper, bearerToken),
    userCodeDigest: await digestDropUserCode(pepper, id, userCode),
    targetManifest: structuredClone(targetManifest),
    state: "pending" as const,
    expiresAtMs: now + Math.max(1_000, ttlMs),
    attempts: 0,
    version: 1,
  };
  const store = readLocalDropClaimStore();
  store.claims[id] = record;
  writeLocalDropClaimStore(store);
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
  const pepper = await localDropDevicePepper();
  const digest = await digestDropBearerToken(pepper, bearerToken);
  const store = readLocalDropClaimStore();
  const raw = store.claims[claimId];
  if (!raw) {
    throw new LocalDropClaimError(
      "refused",
      "This drop claim was not found on this device.",
    );
  }
  const record = freshenLocalDropClaim(raw, Date.now());
  if (!timingSafeEqual(digest, record.tokenDigest)) {
    throw new LocalDropClaimError(
      "refused",
      "This drop's claim token was refused.",
    );
  }
  if (record !== raw) {
    store.claims[claimId] = record;
    writeLocalDropClaimStore(store);
  }
  return localDropPollState(record.state);
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
  const pepper = await localDropDevicePepper();
  const tokenDigest = await digestDropBearerToken(pepper, bearerToken);
  const codeDigest = await digestDropUserCode(pepper, claimId, userCode);
  // Digests are done. Read and write with no await between them, so a revoke
  // cannot land in the middle and have this present put the ciphertext back.
  const store = readLocalDropClaimStore();
  const raw = store.claims[claimId];
  if (!raw) {
    throw refuse(
      "not_found",
      "This drop is not on this device. Open the link in the browser that sealed it, or connect a sign-in service for cross-device drops.",
    );
  }
  const record = freshenLocalDropClaim(raw, Date.now());
  const persist = (next: typeof record) => {
    store.claims[claimId] = next;
    writeLocalDropClaimStore(store);
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
  if (record.attempts >= MAX_DROP_CLAIM_ATTEMPTS) {
    throw refuse(
      "too_many_attempts",
      "Too many wrong codes for this drop. Seal a new one.",
    );
  }
  if (!timingSafeEqual(codeDigest, record.userCodeDigest)) {
    const attempts = record.attempts + 1;
    const triesLeft = MAX_DROP_CLAIM_ATTEMPTS - attempts;
    persist({ ...record, attempts, version: record.version + 1 });
    if (attempts >= MAX_DROP_CLAIM_ATTEMPTS) noteDropLockedOut(claimId);
    throw refuse("invalid_user_code", wrongDropCodeWords(triesLeft), triesLeft);
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
  const pepper = await localDropDevicePepper();
  const digest = await digestDropBearerToken(pepper, bearerToken);
  const store = readLocalDropClaimStore();
  const raw = store.claims[claimId];
  if (!raw) return "missing";
  const record = freshenLocalDropClaim(raw, Date.now());
  if (!timingSafeEqual(digest, record.tokenDigest)) {
    throw new LocalDropClaimError(
      "refused",
      "This drop's claim token was refused.",
    );
  }
  if (record.state === "presented") {
    if (record !== raw) {
      store.claims[claimId] = record;
      writeLocalDropClaimStore(store);
    }
    return "already_consumed";
  }
  const next = {
    ...record,
    state: "revoked" as const,
    targetManifest: {},
    version: record.version + 1,
  };
  store.claims[claimId] = next;
  writeLocalDropClaimStore(store);
  return "revoked";
}

/** Test seam — wipe local drop claims and pepper. */
export function resetLocalDropClaimsForTests(): void {
  resetLocalDropClaimSlotForTests();
}
