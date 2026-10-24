/**
 * Browser-local drop claim plane — backend for the device-native Identity
 * host (ADR 0062 + ADR 0118). Claim digests and the device pepper live in
 * the OPFS kv, never localStorage. `device-identity-host` exposes them as
 * `/v1/claims*`. Deliberately does not import `drop.ts`.
 */

import { ceremonyPath } from "@opensesame/ceremony-kit/links";
import { type JsonObject, isString } from "@opensesame/os-domain";
import { bytesToB64url } from "@opensesame/sdk-browser";
import { env } from "../../host.js";
import { type WebStorage, maybePage } from "../../ports.js";
import {
  noteDropLockedOut,
  noteDropOpened,
  noteDropRefused,
} from "../sharing-receipts.js";
import {
  DROP_LOCKOUT_WORDS,
  type LocalClaimChange,
  type LocalDropPollState,
  MAX_DROP_CLAIM_ATTEMPTS,
  digestDropBearerToken,
  digestDropUserCode,
  freshenLocalDropClaim,
  localDropClaimStorage,
  localDropDevicePepper,
  localDropPollState,
  resetLocalDropClaimSlotForTests,
  updateLocalDropClaimStore,
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
export async function disposeExpiredLocalDropClaims(
  now = Date.now(),
): Promise<void> {
  await updateLocalDropClaimStore((store) => {
    let changed = false;
    for (const [id, raw] of Object.entries(store.claims)) {
      const next = freshenLocalDropClaim(raw, now);
      if (next === raw) continue;
      store.claims[id] = next;
      changed = true;
    }
    return { value: undefined, changed };
  });
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
  await updateLocalDropClaimStore((store) => {
    store.claims[id] = record;
    return { value: undefined, changed: true };
  });
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
  return updateLocalDropClaimStore((store) => {
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
    if (record !== raw) store.claims[claimId] = record;
    return {
      value: localDropPollState(record.state),
      changed: record !== raw,
    };
  });
}

export type PresentedLocalDrop = {
  claimId: string;
  state: LocalDropPollState;
  targetManifest: JsonObject;
};

type PresentDecision =
  | { kind: "presented"; manifest: JsonObject }
  | {
      kind: "refused";
      wire: string;
      message: string;
      attemptsLeft?: number;
      wrongCodes?: number;
      note: "refused" | "locked";
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
  const decision = await updateLocalDropClaimStore<PresentDecision>((store) => {
    const raw = store.claims[claimId];
    if (!raw) {
      noteDropRefused(claimId);
      throw refuse(
        "not_found",
        "This drop is not on this device. Open the link in the browser that sealed it, or connect a sign-in service for cross-device drops.",
      );
    }
    const record = freshenLocalDropClaim(raw, Date.now());
    const changed = record !== raw;
    if (record.state !== "pending") {
      if (changed) store.claims[claimId] = record;
      if (record.state === "revoked")
        return {
          value: {
            kind: "refused",
            wire: "REVOKED",
            message: "This drop was revoked.",
            note: "refused",
          },
          changed,
        } satisfies LocalClaimChange<PresentDecision>;
      if (record.state === "expired")
        return {
          value: {
            kind: "refused",
            wire: "EXPIRED",
            message: "This drop has expired.",
            note: "refused",
          },
          changed,
        } satisfies LocalClaimChange<PresentDecision>;
      if (record.state === "locked_out")
        return {
          value: {
            kind: "refused",
            wire: "too_many_attempts",
            message: DROP_LOCKOUT_WORDS,
            note: "locked",
          },
          changed,
        } satisfies LocalClaimChange<PresentDecision>;
      return {
        value: {
          kind: "refused",
          wire: "INVALID_TRANSITION",
          message: "This drop was already opened and cannot be opened again.",
          note: "refused",
        },
        changed,
      } satisfies LocalClaimChange<PresentDecision>;
    }
    if (!timingSafeEqual(tokenDigest, record.tokenDigest)) {
      throw refuse("invalid_token", "This drop's claim token was refused.");
    }
    if (record.attempts >= MAX_DROP_CLAIM_ATTEMPTS) {
      store.claims[claimId] = {
        ...record,
        state: "locked_out",
        targetManifest: {},
        version: record.version + 1,
      };
      return {
        value: {
          kind: "refused",
          wire: "too_many_attempts",
          message: DROP_LOCKOUT_WORDS,
          note: "locked",
        },
        changed: true,
      } satisfies LocalClaimChange<PresentDecision>;
    }
    if (!timingSafeEqual(codeDigest, record.userCodeDigest)) {
      const attempts = record.attempts + 1;
      const triesLeft = MAX_DROP_CLAIM_ATTEMPTS - attempts;
      const lockedOut = attempts >= MAX_DROP_CLAIM_ATTEMPTS;
      store.claims[claimId] = {
        ...record,
        attempts,
        state: lockedOut ? "locked_out" : record.state,
        ...(lockedOut ? { targetManifest: {} } : undefined),
        version: record.version + 1,
      };
      return {
        value: {
          kind: "refused",
          wire: lockedOut ? "too_many_attempts" : "invalid_user_code",
          message: lockedOut
            ? DROP_LOCKOUT_WORDS
            : wrongDropCodeWords(triesLeft),
          ...(lockedOut ? undefined : { attemptsLeft: triesLeft }),
          wrongCodes: attempts,
          note: lockedOut ? "locked" : "refused",
        },
        changed: true,
      } satisfies LocalClaimChange<PresentDecision>;
    }
    const manifest = structuredClone(record.targetManifest);
    store.claims[claimId] = {
      ...record,
      state: "presented",
      targetManifest: {},
      attempts: 0,
      version: record.version + 1,
    };
    return {
      value: { kind: "presented", manifest },
      changed: true,
    } satisfies LocalClaimChange<PresentDecision>;
  });
  if (decision.kind === "presented") {
    noteDropOpened(claimId);
    return { claimId, state: "consumed", targetManifest: decision.manifest };
  }
  // The code that locks the drop was a wrong code too: it is counted on the
  // refused receipt before the lockout is noted, so the tally reaches five.
  if (decision.wrongCodes !== undefined)
    noteDropRefused(claimId, decision.wrongCodes);
  else if (decision.note === "refused") noteDropRefused(claimId);
  if (decision.note === "locked") noteDropLockedOut(claimId);
  throw refuse(decision.wire, decision.message, decision.attemptsLeft);
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
  return updateLocalDropClaimStore<LocalDropRevocation>((store) => {
    const raw = store.claims[claimId];
    if (!raw) return { value: "missing", changed: false };
    const record = freshenLocalDropClaim(raw, Date.now());
    if (!timingSafeEqual(digest, record.tokenDigest)) {
      throw new LocalDropClaimError(
        "refused",
        "This drop's claim token was refused.",
      );
    }
    if (record.state === "presented") {
      if (record !== raw) store.claims[claimId] = record;
      return { value: "already_consumed", changed: record !== raw };
    }
    store.claims[claimId] = {
      ...record,
      state: "revoked",
      targetManifest: {},
      version: record.version + 1,
    };
    return { value: "revoked", changed: true };
  });
}

/** Test seam — wipe local drop claims and pepper. */
export function resetLocalDropClaimsForTests(): void {
  resetLocalDropClaimSlotForTests();
}
