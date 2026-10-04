/**
 * Where a relying party keeps what it must remember between sending a person
 * to the Self-Issued OP and hearing back: the login it started, and the
 * tokens it has already accepted.
 *
 * Both are interfaces because the right home differs: a Node process behind
 * one instance keeps them in memory, several instances share a store with an
 * atomic get-and-delete (`GETDEL`, `DELETE ... RETURNING`), and a browser SPA
 * keeps them in `sessionStorage` because the redirect is a full navigation.
 * The memory implementations are bounded; none grows without limit.
 */

import {
  type JsonValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";

export type PendingSiopLogin = {
  /** The application id this login asked for: the one `aud` must be. */
  readonly clientId: string;
  readonly nonce: string;
  /** The exact redirect_uri this login sent; the response must arrive there. */
  readonly redirectUri: string;
  readonly createdAtMs: number;
  /** Failed completions so far; a login that keeps failing is burned. */
  readonly attempts: number;
};

export interface SiopLoginStore {
  put(state: string, login: PendingSiopLogin): void | Promise<void>;
  /**
   * Remove and return a login, atomically. Two concurrent calls for one state
   * must not both receive it: that single-winner property *is* the replay
   * defence for the state, so a store that cannot give it must not be used.
   */
  take(
    state: string,
  ): PendingSiopLogin | undefined | Promise<PendingSiopLogin | undefined>;
}

export interface SiopReplayLedger {
  /** True when `key` was unseen and is now recorded until `expiresAtMs`. */
  claim(
    key: string,
    expiresAtMs: number,
    nowMs: number,
  ): boolean | Promise<boolean>;
  /** True while `key` is recorded. Never records. */
  has(key: string, nowMs: number): boolean | Promise<boolean>;
}

export const DEFAULT_MAX_PENDING_LOGINS = 10_000;
export const DEFAULT_MAX_LEDGER_ENTRIES = 50_000;
export const DEFAULT_LOGIN_TTL_MS = 10 * 60 * 1000;

/** Pending logins in one process, oldest evicted first once full. */
export class MemoryLoginStore implements SiopLoginStore {
  readonly #pending = new Map<string, PendingSiopLogin>();
  readonly #max: number;
  readonly #ttlMs: number;

  constructor(
    maxEntries = DEFAULT_MAX_PENDING_LOGINS,
    ttlMs = DEFAULT_LOGIN_TTL_MS,
  ) {
    this.#max = maxEntries;
    this.#ttlMs = ttlMs;
  }

  get size(): number {
    return this.#pending.size;
  }

  put(state: string, login: PendingSiopLogin): void {
    this.#pending.delete(state);
    for (const [key, held] of this.#pending) {
      if (login.createdAtMs - held.createdAtMs > this.#ttlMs) {
        this.#pending.delete(key);
      }
    }
    while (this.#pending.size >= this.#max) {
      const oldest = this.#pending.keys().next();
      if (oldest.done === true) break;
      this.#pending.delete(oldest.value);
    }
    this.#pending.set(state, login);
  }

  take(state: string): PendingSiopLogin | undefined {
    const login = this.#pending.get(state);
    this.#pending.delete(state);
    return login;
  }
}

/** Tokens and states already accepted, in one process, bounded. */
export class MemoryReplayLedger implements SiopReplayLedger {
  readonly #seen = new Map<string, number>();
  readonly #max: number;

  constructor(maxEntries = DEFAULT_MAX_LEDGER_ENTRIES) {
    this.#max = maxEntries;
  }

  get size(): number {
    return this.#seen.size;
  }

  #prune(nowMs: number): void {
    for (const [key, expiresAtMs] of this.#seen) {
      if (expiresAtMs <= nowMs) this.#seen.delete(key);
    }
    while (this.#seen.size >= this.#max) {
      const oldest = this.#seen.keys().next();
      if (oldest.done === true) break;
      this.#seen.delete(oldest.value);
    }
  }

  claim(key: string, expiresAtMs: number, nowMs: number): boolean {
    if (this.has(key, nowMs)) return false;
    this.#prune(nowMs);
    this.#seen.set(key, expiresAtMs);
    return true;
  }

  has(key: string, nowMs: number): boolean {
    const expiresAtMs = this.#seen.get(key);
    if (expiresAtMs === undefined) return false;
    if (expiresAtMs <= nowMs) {
      this.#seen.delete(key);
      return false;
    }
    return true;
  }
}

/** The slice of `Storage` a browser relying party needs. */
export type LoginStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const STORAGE_PREFIX = "siop-rp:login:";

function readLogin(raw: string): PendingSiopLogin | undefined {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) return undefined;
  const { clientId, nonce, redirectUri, createdAtMs, attempts } = parsed;
  if (
    !isString(clientId) ||
    !isString(nonce) ||
    !isString(redirectUri) ||
    !isNumber(createdAtMs) ||
    !isNumber(attempts)
  ) {
    return undefined;
  }
  return { clientId, nonce, redirectUri, createdAtMs, attempts };
}

/**
 * Pending logins in `sessionStorage` (or any `Storage`-shaped object), for a
 * single-page relying party whose redirect is a full page navigation. A
 * browser tab is single-threaded, so read-then-remove is atomic here.
 */
export class StorageLoginStore implements SiopLoginStore {
  readonly #storage: LoginStorage;

  constructor(storage: LoginStorage) {
    this.#storage = storage;
  }

  put(state: string, login: PendingSiopLogin): void {
    this.#storage.setItem(`${STORAGE_PREFIX}${state}`, JSON.stringify(login));
  }

  take(state: string): PendingSiopLogin | undefined {
    const key = `${STORAGE_PREFIX}${state}`;
    const raw = this.#storage.getItem(key);
    this.#storage.removeItem(key);
    return raw === null ? undefined : readLogin(raw);
  }
}
