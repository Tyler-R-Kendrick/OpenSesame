/**
 * Auth-generation fence and durable automatic-reentry suppression.
 *
 * Sign-out increments generation and records suppression synchronously
 * before any network or SDK work. A late callback whose generation does
 * not match is refused.
 */

const GENERATION_KEY = "opensesame:ambient-auth:generation";
const SUPPRESSION_KEY = "opensesame:ambient-auth:suppressed";

export type AuthFence = {
  generation: number;
  suppressed: boolean;
};

function readNumber(key: string): number {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeNumber(key: string, value: number): void {
  try {
    // ast-grep-ignore: ts-localstorage-set
    globalThis.localStorage?.setItem(key, String(value));
  } catch {
    /* quota / private mode */
  }
}

export function readAuthFence(): AuthFence {
  return {
    generation: readNumber(GENERATION_KEY),
    suppressed: readSuppressed(),
  };
}

function readSuppressed(): boolean {
  try {
    return globalThis.localStorage?.getItem(SUPPRESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function currentAuthGeneration(): number {
  return readAuthFence().generation;
}

export function isAutoAuthSuppressed(): boolean {
  return readAuthFence().suppressed;
}

/**
 * Commit suppression and bump generation before awaiting anything. Returns
 * the new fence so callers can stamp in-flight work.
 */
export function fenceLocalSignOut(): AuthFence {
  const next = currentAuthGeneration() + 1;
  writeNumber(GENERATION_KEY, next);
  try {
    // ast-grep-ignore: ts-localstorage-set
    globalThis.localStorage?.setItem(SUPPRESSION_KEY, "1");
  } catch {
    /* storage unavailable — generation bump still fences in-memory callers */
  }
  return { generation: next, suppressed: true };
}

/** A deliberate new sign-in (not automatic) may lift suppression. */
export function clearAutoAuthSuppression(): void {
  try {
    globalThis.localStorage?.removeItem(SUPPRESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function matchesAuthGeneration(expected: number): boolean {
  return currentAuthGeneration() === expected;
}

const ATTEMPT_KEY = "opensesame:ambient-auth:attempt";

export type AttemptRecord = {
  providerKey: string;
  policyRevision: string;
  at: number;
};

export function readAttemptRecord(): AttemptRecord | null {
  try {
    const raw = globalThis.localStorage?.getItem(ATTEMPT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as AttemptRecord).providerKey !== "string" ||
      typeof (parsed as AttemptRecord).policyRevision !== "string" ||
      typeof (parsed as AttemptRecord).at !== "number"
    ) {
      return null;
    }
    return parsed as AttemptRecord;
  } catch {
    return null;
  }
}

export function writeAttemptRecord(record: AttemptRecord): void {
  try {
    // ast-grep-ignore: ts-localstorage-set
    globalThis.localStorage?.setItem(ATTEMPT_KEY, JSON.stringify(record));
  } catch {
    /* quota / private mode */
  }
}

export function clearAttemptRecord(): void {
  try {
    globalThis.localStorage?.removeItem(ATTEMPT_KEY);
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
