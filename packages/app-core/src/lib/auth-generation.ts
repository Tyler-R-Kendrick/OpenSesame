/** Shared principal-generation fence; all sign-in roads use the same durable counter. */
import { maybeLocalStore } from "../ports.js";
import { notifyFederationSessionChanged } from "./federation-session-events.js";
const GENERATION_KEY = "opensesame:ambient-auth:generation";
function readNumber(key: string): number {
  try {
    const raw = maybeLocalStore()?.getItem(key);
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
    maybeLocalStore()?.setItem(key, String(value));
  } catch {
    /* quota / private mode */
  }
}

export function currentAuthGeneration(): number {
  return readNumber(GENERATION_KEY);
}
/** Advance synchronously before any asynchronous sign-out work; the persisted key is unchanged. */
export function advanceAuthGeneration(): number {
  const next = currentAuthGeneration() + 1;
  writeNumber(GENERATION_KEY, next);
  notifyFederationSessionChanged();
  return next;
}
export function matchesAuthGeneration(expected: number): boolean {
  return currentAuthGeneration() === expected;
}
