/**
 * What the browser client keeps between a sign-in and its callback, and after:
 * the PKCE transaction, the return path and the session. Every value reaches
 * the store sealed under the origin's at-rest key (ADR 0148,
 * `@opensesame/browser-at-rest`), bound to its key; a refresh token never
 * reaches the store at all. Where the origin can keep no key, values stay in
 * memory for the life of the document rather than rest in the clear.
 */

import {
  type SealedStorage,
  type StorageLike,
  sealedStorage,
} from "@opensesame/browser-at-rest";
import { overlapCast } from "@opensesame/os-domain";
import type { Session, TokenResponse } from "./types.js";

export const PKCE_KEY = "opensesame:pkce";
export const SESSION_KEY = "opensesame:session";
export const RETURN_TO_KEY = "opensesame:returnTo";
const SCOPE = "sdk-browser";

class MemoryStorage implements StorageLike {
  readonly #map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
}

/**
 * Default away from localStorage: tokens/PKCE must not survive as durable
 * XSS-exfiltrable material across browser restarts. sessionStorage still
 * survives the OAuth redirect in the same tab; memory is last resort.
 */
function resolveStorage(storage?: StorageLike): StorageLike {
  if (storage) return storage;
  if (globalThis !== undefined && "sessionStorage" in globalThis) {
    try {
      const ss = globalThis.sessionStorage;
      // Touch to ensure the Storage is usable (private mode quirks).
      ss.getItem("opensesame:probe");
      return ss;
    } catch {
      /* fall through */
    }
  }
  return new MemoryStorage();
}

/** Persist session without refresh tokens (keep those in-process only). */
function sessionForStorage(session: Session): Session {
  const { refreshToken: _drop, ...rest } = session;
  if (rest.raw) {
    const stored: TokenResponse = overlapCast(rest.raw);
    const { refresh_token: _omit, ...raw } = stored;
    const nextRaw: TokenResponse = overlapCast(raw);
    return { ...rest, raw: nextRaw };
  }
  return rest;
}

export type SessionStore = {
  sealed: SealedStorage;
  saveSession(session: Session): Promise<void>;
  readSession(): Promise<Session | null>;
  forgetSession(): void;
  /** The return path, once `returnToReady` has settled. */
  returnTo(): string | null;
  returnToReady: Promise<void>;
  setReturnTo(value: string | null): Promise<void>;
  /**
   * Keep the PKCE transaction for the page after the redirect. It must reach
   * storage sealed (ADR 0148): an origin that can keep no key cannot sign in.
   */
  savePkce(value: string): Promise<void>;
  /** Take the PKCE transaction: gone from storage before this returns. */
  takePkce(): Promise<string | null>;
};

export function createSessionStore(storage?: StorageLike): SessionStore {
  const sealed = sealedStorage(resolveStorage(storage), SCOPE);
  /** In-tab refresh token; never written to the store. */
  let refreshTokenMemory: string | undefined;
  let returnTo: string | null = null;
  let returnToSet = false;
  const returnToReady = sealed.get(RETURN_TO_KEY).then(
    (stored) => {
      if (!returnToSet) returnTo = stored;
    },
    () => {},
  );
  return {
    sealed,
    async saveSession(session) {
      if (session.refreshToken) refreshTokenMemory = session.refreshToken;
      await sealed.set(SESSION_KEY, JSON.stringify(sessionForStorage(session)));
    },
    async readSession() {
      const raw = await sealed.get(SESSION_KEY);
      if (!raw) return null;
      try {
        const session: Session = overlapCast(JSON.parse(raw));
        if (!session.refreshToken && refreshTokenMemory) {
          session.refreshToken = refreshTokenMemory;
        }
        return session;
      } catch {
        sealed.remove(SESSION_KEY);
        return null;
      }
    },
    forgetSession() {
      refreshTokenMemory = undefined;
      sealed.remove(SESSION_KEY);
      sealed.remove(PKCE_KEY);
    },
    returnTo: () => returnTo,
    returnToReady,
    async savePkce(value) {
      if ((await sealed.set(PKCE_KEY, value)) === "stored") return;
      sealed.remove(PKCE_KEY);
      throw new Error(
        "This browser keeps no storage key; sign-in cannot resume",
      );
    },
    takePkce: () => sealed.take(PKCE_KEY),
    async setReturnTo(value) {
      returnToSet = true;
      returnTo = value;
      if (value === null) sealed.remove(RETURN_TO_KEY);
      else await sealed.set(RETURN_TO_KEY, value);
    },
  };
}
