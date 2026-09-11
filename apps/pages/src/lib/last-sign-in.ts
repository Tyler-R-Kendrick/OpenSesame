/**
 * Which third-party sign-in this device last completed.
 *
 * The social bar is a row of similar brand marks. Remembering the method that
 * actually finished — not the one that was tapped and cancelled — is what
 * stops a Google user from walking into GitHub. Sign-out clears the
 * federation session; this record is separate, so the mark is still there
 * on the way back in.
 */

import { signInMethods } from "./settings.js";

export const LAST_SIGN_IN_KEY = "opensesame:federation:last-method";

/** Shoo is Google; a brokered catalog row is `broker:<id>`. */
export function canonicalSignInMethod(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "shoo") return "google";
  if (lower.startsWith("broker:byo:")) return "byo";
  if (lower.startsWith("broker:org:")) return lower;
  if (lower.startsWith("broker:")) return lower.slice("broker:".length);
  if (lower.startsWith("operator:")) {
    const issuer = trimmed.slice("operator:".length);
    const idp = signInMethods().providers.find(
      (entry) =>
        entry.issuer.replace(/\/+$/, "") === issuer.replace(/\/+$/, ""),
    );
    return (idp?.providerId ?? issuer).toLowerCase();
  }
  return lower;
}

export function isLastSignInMethod(
  candidate: string,
  last: string | null,
): boolean {
  if (!last) return false;
  const left = canonicalSignInMethod(candidate);
  const right = canonicalSignInMethod(last);
  return Boolean(left) && left === right;
}

export function promoteLastSignIn<T>(
  items: readonly T[],
  last: string | null,
  idOf: (item: T) => string,
): T[] {
  if (!last || items.length < 2) return [...items];
  const index = items.findIndex((item) => isLastSignInMethod(idOf(item), last));
  if (index <= 0) return [...items];
  const next = [...items];
  const [hit] = next.splice(index, 1);
  return hit ? [hit, ...next] : next;
}

function rememberLastSignInDefault(id: string): void {
  const canonical = canonicalSignInMethod(id);
  if (!canonical) return;
  // ast-grep-ignore: ts-localstorage-set
  localStorage.setItem(LAST_SIGN_IN_KEY, canonical);
}

function readLastSignInDefault(): string | null {
  const raw = localStorage.getItem(LAST_SIGN_IN_KEY);
  if (!raw) return null;
  return canonicalSignInMethod(raw) || null;
}

export const lastSignInSeams = {
  rememberLastSignIn: rememberLastSignInDefault,
  readLastSignIn: readLastSignInDefault,
};

export function rememberLastSignIn(id: string): void {
  lastSignInSeams.rememberLastSignIn(id);
}

export function readLastSignIn(): string | null {
  return lastSignInSeams.readLastSignIn();
}
