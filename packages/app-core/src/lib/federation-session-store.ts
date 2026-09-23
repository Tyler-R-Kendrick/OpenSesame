import { maybeLocalStore, maybeSessionStore } from "../ports.js";
/** Raw persistence for the federation upstream session (module-size seam). */

const SESSION_KEY = "opensesame:federation:session";

export function writeFederationSessionJson(json: string): void {
  try {
    // ast-grep-ignore: ts-localstorage-set
    maybeLocalStore()?.setItem(SESSION_KEY, json);
  } catch {
    /* Node without --localstorage-file, or quota / private mode */
  }
}

export function readFederationSessionJson(): string | null {
  try {
    return (
      maybeLocalStore()?.getItem(SESSION_KEY) ??
      maybeSessionStore()?.getItem(SESSION_KEY) ??
      null
    );
  } catch {
    return null;
  }
}

export function clearFederationSessionJson(): void {
  try {
    maybeLocalStore()?.removeItem(SESSION_KEY);
    maybeSessionStore()?.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}
