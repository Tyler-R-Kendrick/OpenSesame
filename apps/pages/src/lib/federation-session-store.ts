/** Raw persistence for the federation upstream session (module-size seam). */

const SESSION_KEY = "opensesame:federation:session";

export function writeFederationSessionJson(json: string): void {
  try {
    // ast-grep-ignore: ts-localstorage-set
    globalThis.localStorage?.setItem(SESSION_KEY, json);
  } catch {
    /* Node without --localstorage-file, or quota / private mode */
  }
}

export function readFederationSessionJson(): string | null {
  try {
    return (
      globalThis.localStorage?.getItem(SESSION_KEY) ??
      globalThis.sessionStorage?.getItem(SESSION_KEY) ??
      null
    );
  } catch {
    return null;
  }
}

export function clearFederationSessionJson(): void {
  try {
    globalThis.localStorage?.removeItem(SESSION_KEY);
    globalThis.sessionStorage?.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}
