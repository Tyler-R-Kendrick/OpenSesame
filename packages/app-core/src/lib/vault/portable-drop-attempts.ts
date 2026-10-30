/** Recipient-local wrong-code accounting for portable drops. */

import { type WebStorage, maybeSessionStore } from "../../ports.js";

const ATTEMPT_KEY_PREFIX = "opensesame.portable-drop-attempts.v1.";
const fallbackAttempts = new Map<string, number>();

function key(claimId: string): string {
  return `${ATTEMPT_KEY_PREFIX}${claimId}`;
}

function storage(): WebStorage | undefined {
  try {
    return maybeSessionStore();
  } catch {
    return undefined;
  }
}

export function portableDropWrongAttempts(claimId: string): number {
  const fallback = fallbackAttempts.get(claimId) ?? 0;
  const store = storage();
  if (!store) return fallback;
  try {
    const raw = store.getItem(key(claimId));
    if (raw === null) return fallback;
    const attempts = Number(raw);
    return Number.isSafeInteger(attempts) && attempts >= 0
      ? Math.max(attempts, fallback)
      : fallback;
  } catch {
    return fallback;
  }
}

export function recordPortableDropWrongAttempt(claimId: string): number {
  const attempts = portableDropWrongAttempts(claimId) + 1;
  const store = storage();
  if (!store) {
    fallbackAttempts.set(claimId, attempts);
    return attempts;
  }
  try {
    store.setItem(key(claimId), String(attempts));
    fallbackAttempts.delete(claimId);
  } catch {
    fallbackAttempts.set(claimId, attempts);
  }
  return attempts;
}

export function clearPortableDropWrongAttempts(claimId: string): void {
  fallbackAttempts.delete(claimId);
  try {
    storage()?.removeItem(key(claimId));
  } catch {
    // The in-memory count is already gone; a blocked store cannot be changed.
  }
}

export function resetPortableDropAttemptsForTests(): void {
  fallbackAttempts.clear();
  const store = storage();
  if (!store) return;
  const keys: string[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const name = store.key(index);
      if (name?.startsWith(ATTEMPT_KEY_PREFIX)) keys.push(name);
    }
    for (const name of keys) store.removeItem(name);
  } catch {
    // Tests also clear their host storage; a blocked store has no readable keys.
  }
}
