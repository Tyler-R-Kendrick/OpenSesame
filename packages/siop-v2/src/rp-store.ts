/**
 * Where a relying party keeps what it must remember between sending a person
 * to the Self-Issued OP and hearing back: the login it started, and the
 * tokens it has already accepted.
 *
 * Both are interfaces because the right home differs: a Node process behind
 * one instance keeps them in memory, several instances share a store with an
 * atomic get-and-delete (`GETDEL`, `DELETE ... RETURNING`), and a browser SPA
 * keeps its one pending login in the tab's storage because the redirect is a
 * full navigation.
 *
 * Every implementation here is bounded, and a full pending-login store
 * **refuses** a new login instead of evicting a live one: an attacker who can
 * start logins must not be able to push a victim's out. Expired logins are
 * pruned first, from the oldest end, so a call costs the entries it removes
 * and not the entries it holds. The replay ledger, by contrast, evicts its
 * oldest entry when full: it only ever records tokens that already verified.
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
  /** The secret of the browser that started this login. */
  readonly binding: string;
  readonly nonce: string;
  /** The exact redirect_uri this login sent; the response must arrive there. */
  readonly redirectUri: string;
  readonly createdAtMs: number;
  /** Failed completions so far; a login that keeps failing is burned. */
  readonly attempts: number;
};

export interface SiopLoginStore {
  /**
   * Keep a login. `false` means the store is full of live logins and refused
   * it; the caller must not start the login.
   */
  put(state: string, login: PendingSiopLogin): boolean | Promise<boolean>;
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
export const DEFAULT_MAX_STORED_LOGINS = 16;
export const DEFAULT_LOGIN_TTL_MS = 10 * 60 * 1000;

/** Pending logins in one process; full means refused, never evicted. */
export class MemoryLoginStore implements SiopLoginStore {
  readonly #pending = new Map<string, PendingSiopLogin>();
  readonly #max: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(
    maxEntries = DEFAULT_MAX_PENDING_LOGINS,
    ttlMs = DEFAULT_LOGIN_TTL_MS,
    now: () => number = () => Date.now(),
  ) {
    this.#max = maxEntries;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get size(): number {
    return this.#pending.size;
  }

  /** Drop expired logins from the oldest end, and stop at the first live one. */
  #pruneExpired(): void {
    const nowMs = this.#now();
    for (const [state, held] of this.#pending) {
      if (nowMs - held.createdAtMs <= this.#ttlMs) return;
      this.#pending.delete(state);
    }
  }

  put(state: string, login: PendingSiopLogin): boolean {
    this.#pending.delete(state);
    this.#pruneExpired();
    if (this.#pending.size >= this.#max) return false;
    this.#pending.set(state, login);
    return true;
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

  /** Only at capacity: drop what has expired, then the oldest if still full. */
  #makeRoom(nowMs: number): void {
    if (this.#seen.size < this.#max) return;
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
    this.#makeRoom(nowMs);
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
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const STORAGE_PREFIX = "siop-rp:login:";

/** A stored login read back, or undefined when it is not one. */
export function readLogin(raw: string): PendingSiopLogin | undefined {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) return undefined;
  const { clientId, binding, nonce, redirectUri, createdAtMs, attempts } =
    parsed;
  if (
    !isString(clientId) ||
    !isString(binding) ||
    !isString(nonce) ||
    !isString(redirectUri) ||
    !isNumber(createdAtMs) ||
    !isNumber(attempts)
  ) {
    return undefined;
  }
  return { clientId, binding, nonce, redirectUri, createdAtMs, attempts };
}

/**
 * Pending logins in a `Storage`-shaped object a page can read synchronously
 * (a test, an embedder's own store). Bounded like the memory store: a `put`
 * prunes what has expired, then refuses when `maxEntries` live logins are
 * kept. A browser tab is single-threaded, so read-then-remove is atomic here.
 * A page that must not leave a login in the clear seals its store instead
 * (`examples/siop-rp/src/spa` uses `@opensesame/browser-at-rest`).
 */
export class StorageLoginStore implements SiopLoginStore {
  readonly #storage: LoginStorage;
  readonly #max: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(
    storage: LoginStorage,
    maxEntries = DEFAULT_MAX_STORED_LOGINS,
    ttlMs = DEFAULT_LOGIN_TTL_MS,
    now: () => number = () => Date.now(),
  ) {
    this.#storage = storage;
    this.#max = maxEntries;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  #ownKeys(): string[] {
    const keys: string[] = [];
    for (let index = 0; index < this.#storage.length; index += 1) {
      const key = this.#storage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    return keys;
  }

  put(state: string, login: PendingSiopLogin): boolean {
    const mine = `${STORAGE_PREFIX}${state}`;
    this.#storage.removeItem(mine);
    const nowMs = this.#now();
    let live = 0;
    for (const key of this.#ownKeys()) {
      const raw = this.#storage.getItem(key);
      const held = raw === null ? undefined : readLogin(raw);
      if (held === undefined || nowMs - held.createdAtMs > this.#ttlMs) {
        this.#storage.removeItem(key);
      } else {
        live += 1;
      }
    }
    if (live >= this.#max) return false;
    this.#storage.setItem(mine, JSON.stringify(login));
    return true;
  }

  take(state: string): PendingSiopLogin | undefined {
    const key = `${STORAGE_PREFIX}${state}`;
    const raw = this.#storage.getItem(key);
    this.#storage.removeItem(key);
    return raw === null ? undefined : readLogin(raw);
  }
}
