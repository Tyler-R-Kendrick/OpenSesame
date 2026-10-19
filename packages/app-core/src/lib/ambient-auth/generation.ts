/**
 * Auth-generation fence and durable automatic-reentry suppression.
 *
 * Sign-out increments generation and records suppression synchronously
 * before any network or SDK work. A late callback whose generation does
 * not match is refused.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { maybeLocalStore } from "../../ports.js";

import {
  advanceAuthGeneration,
  currentAuthGeneration,
} from "../auth-generation.js";
export {
  currentAuthGeneration,
  matchesAuthGeneration,
} from "../auth-generation.js";

const SUPPRESSION_KEY = "opensesame:ambient-auth:suppressed";

export type AuthFence = {
  generation: number;
  suppressed: boolean;
};

export function readAuthFence(): AuthFence {
  return {
    generation: currentAuthGeneration(),
    suppressed: readSuppressed(),
  };
}

function readSuppressed(): boolean {
  try {
    return maybeLocalStore()?.getItem(SUPPRESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function isAutoAuthSuppressed(): boolean {
  return readAuthFence().suppressed;
}

/**
 * Commit suppression and bump generation before awaiting anything. Returns
 * the new fence so callers can stamp in-flight work.
 */
export function fenceLocalSignOut(): AuthFence {
  const next = advanceAuthGeneration();
  try {
    // ast-grep-ignore: ts-localstorage-set
    maybeLocalStore()?.setItem(SUPPRESSION_KEY, "1");
  } catch {
    /* storage unavailable — generation bump still fences in-memory callers */
  }
  return { generation: next, suppressed: true };
}

/** A deliberate new sign-in (not automatic) may lift suppression. */
export function clearAutoAuthSuppression(): void {
  try {
    maybeLocalStore()?.removeItem(SUPPRESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}

const ATTEMPT_KEY = "opensesame:ambient-auth:attempt";

export type AttemptRecord = {
  providerKey: string;
  policyRevision: string;
  at: number;
};

export function readAttemptRecord(): AttemptRecord | null {
  try {
    const raw = maybeLocalStore()?.getItem(ATTEMPT_KEY);
    if (!raw) return null;
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return null;
    if (
      !isString(parsed.providerKey) ||
      !isString(parsed.policyRevision) ||
      !isNumber(parsed.at)
    ) {
      return null;
    }
    return {
      providerKey: parsed.providerKey,
      policyRevision: parsed.policyRevision,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

export function writeAttemptRecord(record: AttemptRecord): void {
  try {
    // ast-grep-ignore: ts-localstorage-set
    maybeLocalStore()?.setItem(ATTEMPT_KEY, JSON.stringify(record));
  } catch {
    /* quota / private mode */
  }
}

export function clearAttemptRecord(): void {
  try {
    maybeLocalStore()?.removeItem(ATTEMPT_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function attemptOnCooldown(
  now: number,
  cooldownMs: number,
  providerKey: string,
  policyRevision: string,
): boolean {
  const last = readAttemptRecord();
  if (!last) return false;
  if (
    last.providerKey !== providerKey ||
    last.policyRevision !== policyRevision
  ) {
    return false;
  }
  return now - last.at < cooldownMs;
}
