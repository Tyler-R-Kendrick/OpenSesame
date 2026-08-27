import { isBoolean, isNumber, overlapCast } from "@opensesame/os-domain";
/**
 * Vault session store. Holds the unlocked collection in memory, seals every
 * mutation straight back to OPFS, and drops the key on lock.
 */

import {
  kvDelete,
  kvDeleteDurable,
  kvDurability,
  kvGet,
  kvSet,
  kvSetDurable,
} from "../kv.js";
import { scopedKey } from "../projects.js";
import {
  type SealedBlob,
  VaultCorruptError,
  type VaultHeader,
  WrongPasswordError,
  assertSealed,
  createVault,
  importVaultKey,
  mintVaultKey,
  openJson,
  rewrapVaultKey,
  sealJson,
  unwrapRawVaultKeyFromPassword,
  wrapVaultKeyWithPassword,
} from "./crypto.js";
import {
  hostBackupSeams,
  installVaultHostBackupFlushHooks,
  pushSealedVaultToHost,
} from "./host-backup.js";
import {
  type Folder,
  type VaultBody,
  type VaultItem,
  emptyBody,
  mergeVaultBodies,
} from "./model.js";
import { estimateStrength } from "./password.js";
import { totpSetupUri } from "./totp.js";
import {
  type VaultUnlocks,
  assertKeepsPrimaryUnlock,
  assertPinPolicy,
  createPasskeyUnlockCeremony,
  getPasskeyUnlockCeremony,
  openTotpSecret,
  randomTotpSecret,
  sealTotpSecret,
  totpCodeMatches,
  unwrapVaultKeyWithPin,
  unwrapVaultKeyWithPrf,
  webauthnRpId,
  wrapVaultKeyWithPin,
  wrapVaultKeyWithPrf,
} from "./unlock-methods.js";

installVaultHostBackupFlushHooks();

/**
 * Base key names. The store reads and writes them through the active
 * project's scope (`scopedKey`), so each project keeps its own sealed vault.
 */
export const HEADER_KEY = "vault.header.v1";
export const BODY_KEY = "vault.body.v1";
export const ATTEMPTS_KEY = "vault.attempts.v1";
export const PREFS_KEY = "vault.prefs.v1"; // gitleaks:allow -- storage key, not a credential

type VaultKeys = {
  header: string;
  body: string;
  attempts: string;
  prefs: string;
};

function scopedVaultKeys(): VaultKeys {
  return {
    header: scopedKey(HEADER_KEY),
    body: scopedKey(BODY_KEY),
    attempts: scopedKey(ATTEMPTS_KEY),
    prefs: scopedKey(PREFS_KEY),
  };
}

export type VaultStatus = "empty" | "locked" | "unlocked";

export type VaultPrefs = {
  /** Minutes of inactivity before the vault locks. 0 disables the timer. */
  autoLockMinutes: number;
  /** Lock as soon as the tab is hidden. */
  lockOnHide: boolean;
  /**
   * When true, vault lock also ends the Identity/Host session.
   * Off by default — idle vault lock should not sign you out of everything.
   */
  signOutOnLock: boolean;
  /** Seconds before a copied secret is cleared from the clipboard. 0 disables. */
  clipboardClearSeconds: number;
  theme: "system" | "light" | "dark";
  /**
   * Bumped when defaults change so existing devices pick up a one-time
   * migration (e.g. retiring the old 15-minute auto-lock default).
   */
  prefsRevision?: number;
};

/** Current prefs schema revision — bump when shipping a one-time prefs migrate. */
export const VAULT_PREFS_REVISION = 2;

export const defaultPrefs: VaultPrefs = {
  // Off by default: closing the window already drops the key from memory.
  // Operators who want idle lock opt in under Settings → General → Locking.
  autoLockMinutes: 0,
  lockOnHide: false,
  signOutOnLock: false,
  clipboardClearSeconds: 30,
  theme: "system",
  prefsRevision: VAULT_PREFS_REVISION,
};

/** Merge stored prefs with defaults and apply one-time migrations. */
export function normalizeVaultPrefs(
  raw: Partial<VaultPrefs> | null | undefined,
): VaultPrefs {
  const incoming = raw ?? {};
  const merged: VaultPrefs = {
    ...defaultPrefs,
    ...incoming,
    prefsRevision: Math.max(
      Number(incoming.prefsRevision ?? 0) || 0,
      VAULT_PREFS_REVISION,
    ),
  };
  // Revision 2: the previous default was 15 minutes and signed the operator
  // out of Identity on every lock — far too aggressive for normal use.
  const priorRevision = Number(incoming.prefsRevision ?? 0) || 0;
  if (priorRevision < 2 && incoming.autoLockMinutes === 15) {
    merged.autoLockMinutes = 0;
  }
  if (!isBoolean(merged.signOutOnLock)) {
    merged.signOutOnLock = false;
  }
  if (
    !isNumber(merged.autoLockMinutes) ||
    !Number.isFinite(merged.autoLockMinutes) ||
    merged.autoLockMinutes < 0
  ) {
    merged.autoLockMinutes = 0;
  }
  return merged;
}

export type VaultState = {
  status: VaultStatus;
  header: VaultHeader | null;
  items: VaultItem[];
  folders: Folder[];
  prefs: VaultPrefs;
  /** Milliseconds until auto-lock, or null when no timer is armed. */
  lockedOutUntil: number | null;
  failedAttempts: number;
  /**
   * True after a primary unlock (password / PIN / passkey) when MFA is enrolled
   * and the authenticator code has not been confirmed yet.
   */
  awaitingTotp: boolean;
  /**
   * False when this browser gives the app no persistent storage, so the vault
   * lives only until the tab closes. Worth saying out loud before someone
   * trusts it with their only copy of a password.
   */
  durable: boolean;
};

type Listener = () => void;

const LOCK_AFTER_FAILS = 5;
const BASE_LOCKOUT_MS = 5_000;
const MAX_LOCKOUT_MS = 15 * 60_000;

function readJson<T>(key: string, fallback: T): T {
  const raw = kvGet(key);
  if (!raw) return fallback;
  try {
    return overlapCast(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

/** Create and re-key share one policy so a change cannot weaken the KDF input. */
export function assertMasterPasswordPolicy(password: string): void {
  if (password.length < 12) {
    throw new Error(
      "Use at least 12 characters. This key protects everything.",
    );
  }
  if (estimateStrength(password).score < 2) {
    throw new Error(
      "That master password is too easy to guess. Aim for Fair or better.",
    );
  }
}

export class VaultStore {
  #vaultKey: CryptoKey | null = null;
  /** Raw VK for enroll-only wrapKey substitutes; wiped on lock. */
  #rawVaultKey: Uint8Array | null = null;
  /** Primary unwrap succeeded; waiting on optional TOTP before activating. */
  #pendingVaultKey: CryptoKey | null = null;
  #body: VaultBody = emptyBody();
  #header: VaultHeader | null = null;
  #prefs: VaultPrefs = defaultPrefs;
  #listeners = new Set<Listener>();
  #snapshot: VaultState;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #lastActivity = Date.now();
  /** Serializes body writes so overlapping mutations cannot land out of order. */
  #writeChain: Promise<unknown> = Promise.resolve();
  #lockHandlers = new Set<() => void>();
  #keys: VaultKeys = scopedVaultKeys();
  /**
   * Guest / this-tab vault: the key was never wrapped to disk. Locking or
   * reloading must not leave a wrap-less header that cannot be unlocked.
   */
  #ephemeral = false;

  constructor() {
    this.#header = readJson<VaultHeader | null>(this.#keys.header, null);
    this.#prefs = normalizeVaultPrefs(
      readJson<Partial<VaultPrefs>>(this.#keys.prefs, {}),
    );
    this.#persistPrefsIfMigrated();
    this.#snapshot = this.#build();
  }

  /**
   * Re-read plaintext state once OPFS hydration has filled the KV cache.
   * Hydration is also when the active project becomes known, so the key
   * scope is recomputed here before anything is read.
   */
  rehydrate(): void {
    if (this.#vaultKey || this.#pendingVaultKey) return;
    this.#keys = scopedVaultKeys();
    this.#header = readJson<VaultHeader | null>(this.#keys.header, null);
    this.#prefs = normalizeVaultPrefs(
      readJson<Partial<VaultPrefs>>(this.#keys.prefs, {}),
    );
    this.#persistPrefsIfMigrated();
    this.#emit();
  }

  /**
   * Drop the previous project's session and read the active project's header.
   * Identity stays signed in — this is a vault-scope swap, not a reload.
   */
  loadActiveProjectScope(): void {
    this.lock();
    this.#keys = scopedVaultKeys();
    this.#header = readJson<VaultHeader | null>(this.#keys.header, null);
    this.#prefs = normalizeVaultPrefs(
      readJson<Partial<VaultPrefs>>(this.#keys.prefs, {}),
    );
    this.#persistPrefsIfMigrated();
    this.#emit();
  }

  /**
   * Carry the current unlock into the active project. New projects share this
   * device's vault key so creating one does not ask for a password/passkey again.
   */
  async forkUnlockedIntoActiveScope(): Promise<void> {
    if (!this.#vaultKey || !this.#header) {
      throw new Error(
        "Unlock the vault before carrying it into a new project.",
      );
    }
    this.#keys = scopedVaultKeys();
    const header: VaultHeader = {
      v: 1,
      createdAt: new Date().toISOString(),
    };
    if (this.#header.kdf) header.kdf = this.#header.kdf;
    if (this.#header.wrap) header.wrap = this.#header.wrap;
    if (this.#header.unlocks) header.unlocks = { ...this.#header.unlocks };
    if (this.#header.hint) header.hint = this.#header.hint;
    this.#header = header;
    this.#body = emptyBody();
    this.#pendingVaultKey = null;
    await kvSetDurable(this.#keys.header, JSON.stringify(header));
    kvSet(this.#keys.prefs, JSON.stringify(this.#prefs));
    await this.#persist();
    this.touch();
    this.#armIdleTimer();
    this.#emit();
  }

  #persistPrefsIfMigrated(): void {
    const stored = readJson<Partial<VaultPrefs>>(this.#keys.prefs, {});
    if ((stored.prefsRevision ?? 0) >= VAULT_PREFS_REVISION) return;
    kvSet(this.#keys.prefs, JSON.stringify(this.#prefs));
  }

  #build(): VaultState {
    const attempts = readJson<{ fails: number; until: number }>(
      this.#keys.attempts,
      {
        fails: 0,
        until: 0,
      },
    );
    return {
      status: this.#vaultKey ? "unlocked" : this.#header ? "locked" : "empty",
      header: this.#header,
      items: this.#body.items,
      folders: this.#body.folders,
      prefs: this.#prefs,
      lockedOutUntil: attempts.until > Date.now() ? attempts.until : null,
      failedAttempts: attempts.fails,
      awaitingTotp: this.#pendingVaultKey !== null && this.#vaultKey === null,
      durable: kvDurability() !== "memory",
    };
  }

  #emit(): void {
    this.#snapshot = this.#build();
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): VaultState => this.#snapshot;

  // —— session ——————————————————————————————————————————————

  #stashRaw(raw: Uint8Array): void {
    this.#zeroRaw();
    this.#rawVaultKey = raw;
  }

  #zeroRaw(): void {
    this.#rawVaultKey?.fill(0);
    this.#rawVaultKey = null;
  }

  #requireRaw(): Uint8Array {
    if (!this.#rawVaultKey) {
      throw new Error("Unlock the vault before changing unlock methods.");
    }
    return this.#rawVaultKey;
  }

  async create(password: string, hint?: string): Promise<void> {
    assertMasterPasswordPolicy(password);
    const { header, vaultKey, rawVaultKey } = await createVault(password, hint);
    await this.#persistNewVault(header, vaultKey, rawVaultKey);
  }

  /** First-run seal under a passkey PRF wrap — no master password required. */
  async createWithPasskey(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const { vaultKey, rawVaultKey } = await mintVaultKey();
    try {
      const ceremony = await createPasskeyUnlockCeremony(undefined, signal);
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const record = await wrapVaultKeyWithPrf(
        rawVaultKey,
        ceremony.prfOutput,
        ceremony.prfSalt,
        ceremony.credential.rawId,
        ceremony.userId,
      );
      const header: VaultHeader = {
        v: 1,
        createdAt: new Date().toISOString(),
        unlocks: { passkey: record },
      };
      await this.#persistNewVault(header, vaultKey, rawVaultKey);
    } catch (error) {
      rawVaultKey.fill(0);
      throw error;
    }
  }

  /**
   * First-run guest session: no passkey, PIN, or password. The vault key lives
   * in this tab only until an unlock method is enrolled.
   */
  async createGuest(): Promise<void> {
    const { vaultKey, rawVaultKey } = await mintVaultKey();
    this.#header = {
      v: 1,
      createdAt: new Date().toISOString(),
    };
    this.#vaultKey = vaultKey;
    this.#stashRaw(rawVaultKey);
    this.#pendingVaultKey = null;
    this.#body = emptyBody();
    this.#ephemeral = true;
    this.touch();
    this.#armIdleTimer();
    this.#emit();
  }

  /** First-run seal under a PIN wrap — no master password required. */
  async createWithPin(pin: string): Promise<void> {
    assertPinPolicy(pin);
    const { vaultKey, rawVaultKey } = await mintVaultKey();
    try {
      const record = await wrapVaultKeyWithPin(rawVaultKey, pin);
      const header: VaultHeader = {
        v: 1,
        createdAt: new Date().toISOString(),
        unlocks: { pin: record },
      };
      await this.#persistNewVault(header, vaultKey, rawVaultKey);
    } catch (error) {
      rawVaultKey.fill(0);
      throw error;
    }
  }

  async #persistNewVault(
    header: VaultHeader,
    vaultKey: CryptoKey,
    rawVaultKey: Uint8Array,
  ): Promise<void> {
    this.#header = header;
    this.#vaultKey = vaultKey;
    this.#stashRaw(rawVaultKey);
    this.#pendingVaultKey = null;
    this.#body = emptyBody();
    this.#ephemeral = false;
    try {
      await kvSetDurable(this.#keys.header, JSON.stringify(header));
      await this.#persist();
    } catch (error) {
      // A vault whose header never reached disk cannot be unlocked again, so
      // leave nothing behind that would claim otherwise.
      this.#header = null;
      this.#vaultKey = null;
      this.#zeroRaw();
      this.#body = emptyBody();
      kvDelete(this.#keys.header);
      kvDelete(this.#keys.body);
      this.#emit();
      throw error;
    }
    kvDelete(this.#keys.attempts);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
  }

  #assertNotLockedOut(): void {
    const attempts = readJson<{ fails: number; until: number }>(
      this.#keys.attempts,
      {
        fails: 0,
        until: 0,
      },
    );
    if (attempts.until > Date.now()) {
      const seconds = Math.ceil((attempts.until - Date.now()) / 1000);
      throw new Error(`Too many attempts. Try again in ${seconds}s.`);
    }
  }

  #recordFailedUnlock(): void {
    const attempts = readJson<{ fails: number; until: number }>(
      this.#keys.attempts,
      {
        fails: 0,
        until: 0,
      },
    );
    const fails = attempts.fails + 1;
    const until =
      fails >= LOCK_AFTER_FAILS
        ? Date.now() +
          Math.min(
            BASE_LOCKOUT_MS * 2 ** (fails - LOCK_AFTER_FAILS),
            MAX_LOCKOUT_MS,
          )
        : 0;
    kvSet(this.#keys.attempts, JSON.stringify({ fails, until }));
    this.#emit();
  }

  async #loadBody(vaultKey: CryptoKey): Promise<VaultBody> {
    const sealed = readJson<SealedBlob | null>(this.#keys.body, null);
    if (!sealed) return emptyBody();
    try {
      const body = await openJson<VaultBody>(vaultKey, sealed);
      const rev = body.rev ?? 0;
      if (rev < (this.#header?.bodyRev ?? 0)) {
        throw new VaultCorruptError(
          "this vault file is older than the last write recorded on this device. " +
            "If you restored a backup, import it from Settings instead; " +
            "the vault here was not opened, so nothing has been lost yet",
        );
      }
      return {
        v: 1,
        items: body.items ?? [],
        folders: body.folders ?? [],
        rev,
      };
    } catch (error) {
      throw error instanceof VaultCorruptError
        ? error
        : new VaultCorruptError("unreadable body");
    }
  }

  async #activateSession(vaultKey: CryptoKey): Promise<void> {
    this.#vaultKey = vaultKey;
    this.#pendingVaultKey = null;
    try {
      this.#body = await this.#loadBody(vaultKey);
    } catch (error) {
      this.#vaultKey = null;
      this.#zeroRaw();
      this.#body = emptyBody();
      throw error;
    }
    kvDelete(this.#keys.attempts);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
  }

  /** After primary unwrap: either activate or wait for TOTP MFA. */
  async #afterPrimaryUnwrap(vaultKey: CryptoKey): Promise<void> {
    if (this.#header?.unlocks?.totp) {
      this.#pendingVaultKey = vaultKey;
      this.#emit();
      return;
    }
    await this.#activateSession(vaultKey);
  }

  async unlock(password: string): Promise<void> {
    this.#assertNotLockedOut();
    if (!this.#header) throw new Error("There is no vault on this device yet.");

    let raw: Uint8Array;
    try {
      raw = await unwrapRawVaultKeyFromPassword(this.#header, password);
    } catch (error) {
      if (!(error instanceof WrongPasswordError)) throw error;
      this.#recordFailedUnlock();
      throw error;
    }
    this.#stashRaw(raw);
    const vaultKey = await importVaultKey(raw);
    await this.#afterPrimaryUnwrap(vaultKey);
  }

  async unlockWithPin(pin: string): Promise<void> {
    this.#assertNotLockedOut();
    if (!this.#header) throw new Error("There is no vault on this device yet.");
    const record = this.#header.unlocks?.pin;
    if (!record) throw new Error("This vault has no PIN unlock.");

    let raw: Uint8Array;
    try {
      raw = await unwrapVaultKeyWithPin(record, pin);
    } catch (error) {
      if (!(error instanceof WrongPasswordError)) throw error;
      this.#recordFailedUnlock();
      throw new WrongPasswordError("That PIN did not unlock the vault.");
    }
    this.#stashRaw(raw);
    const vaultKey = await importVaultKey(raw);
    await this.#afterPrimaryUnwrap(vaultKey);
  }

  async unlockWithPasskey(signal?: AbortSignal): Promise<void> {
    this.#assertNotLockedOut();
    if (!this.#header) throw new Error("There is no vault on this device yet.");
    const record = this.#header.unlocks?.passkey;
    if (!record) throw new Error("This vault has no passkey unlock.");

    let prfOutput: ArrayBuffer;
    try {
      prfOutput = await getPasskeyUnlockCeremony(record, undefined, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw error instanceof Error
        ? error
        : new Error("Passkey unlock failed.");
    }

    let raw: Uint8Array;
    try {
      raw = await unwrapVaultKeyWithPrf(record, prfOutput);
    } catch (error) {
      if (!(error instanceof WrongPasswordError)) throw error;
      this.#recordFailedUnlock();
      throw new WrongPasswordError("That passkey did not unlock the vault.");
    }
    this.#stashRaw(raw);
    const vaultKey = await importVaultKey(raw);
    await this.#afterPrimaryUnwrap(vaultKey);
  }

  async confirmTotp(code: string): Promise<void> {
    this.#assertNotLockedOut();
    const pending = this.#pendingVaultKey;
    const gate = this.#header?.unlocks?.totp;
    if (!pending || !gate) {
      throw new Error("Enter a primary unlock method first.");
    }
    const secret = await openTotpSecret(pending, gate);
    const ok = await totpCodeMatches(secret, code, gate.digits, gate.period);
    if (!ok) {
      this.#recordFailedUnlock();
      throw new WrongPasswordError("That authenticator code is not valid.");
    }
    await this.#activateSession(pending);
  }

  cancelTotpChallenge(): void {
    this.#pendingVaultKey = null;
    this.#emit();
  }

  async #persistHeader(next: VaultHeader): Promise<void> {
    const previous = this.#header;
    this.#header = next;
    try {
      await kvSetDurable(this.#keys.header, JSON.stringify(next));
    } catch (error) {
      this.#header = previous;
      this.#emit();
      throw error;
    }
    this.#ephemeral = false;
    this.#emit();
  }

  #requireUnlocked() {
    if (!this.#vaultKey || !this.#header) {
      throw new Error("Unlock the vault before changing unlock methods.");
    }
    return { vaultKey: this.#vaultKey, header: this.#header };
  }

  async enrollPasskey(): Promise<void> {
    const { header } = this.#requireUnlocked();
    const raw = this.#requireRaw();
    const ceremony = await createPasskeyUnlockCeremony();
    const record = await wrapVaultKeyWithPrf(
      raw,
      ceremony.prfOutput,
      ceremony.prfSalt,
      ceremony.credential.rawId,
      ceremony.userId,
    );
    const unlocks: VaultUnlocks = {
      ...header.unlocks,
      passkey: record,
    };
    await this.#persistHeader({ ...header, unlocks });
  }

  async removePasskey(): Promise<void> {
    if (!this.#header?.unlocks?.passkey) return;
    assertKeepsPrimaryUnlock(this.#header, "passkey");
    const { passkey: _removed, ...rest } = this.#header.unlocks;
    await this.#persistHeader({
      ...this.#header,
      unlocks: Object.keys(rest).length ? rest : undefined,
    });
  }

  async enrollPin(pin: string): Promise<void> {
    const { header } = this.#requireUnlocked();
    assertPinPolicy(pin);
    const record = await wrapVaultKeyWithPin(this.#requireRaw(), pin);
    const unlocks: VaultUnlocks = {
      ...header.unlocks,
      pin: record,
    };
    await this.#persistHeader({ ...header, unlocks });
  }

  async removePin(): Promise<void> {
    if (!this.#header?.unlocks?.pin) return;
    assertKeepsPrimaryUnlock(this.#header, "pin");
    const { pin: _removed, ...rest } = this.#header.unlocks;
    await this.#persistHeader({
      ...this.#header,
      unlocks: Object.keys(rest).length ? rest : undefined,
    });
  }

  async enrollPassword(password: string): Promise<void> {
    const { header } = this.#requireUnlocked();
    assertMasterPasswordPolicy(password);
    const { kdf, wrap } = await wrapVaultKeyWithPassword(
      this.#requireRaw(),
      password,
    );
    await this.#persistHeader({ ...header, kdf, wrap });
  }

  async removePassword(): Promise<void> {
    if (!this.#header?.wrap) return;
    assertKeepsPrimaryUnlock(this.#header, "password");
    const { wrap: _w, kdf: _k, ...rest } = this.#header;
    await this.#persistHeader({
      ...rest,
      wrap: undefined,
      kdf: undefined,
    });
  }

  /**
   * Enroll optional TOTP as a second factor after any primary unlock.
   * Returns an otpauth URI for QR / authenticator setup.
   */
  async enrollTotp(): Promise<string> {
    const { vaultKey, header } = this.#requireUnlocked();
    const secret = randomTotpSecret();
    const gate = await sealTotpSecret(vaultKey, secret);
    const unlocks: VaultUnlocks = {
      ...header.unlocks,
      totp: gate,
    };
    await this.#persistHeader({ ...header, unlocks });
    return totpSetupUri(secret, {
      label: "OpenSesame vault",
      issuer: "OpenSesame",
    });
  }

  async removeTotp(): Promise<void> {
    if (!this.#header?.unlocks?.totp) return;
    const { totp: _removed, ...rest } = this.#header.unlocks;
    await this.#persistHeader({
      ...this.#header,
      unlocks: Object.keys(rest).length ? rest : undefined,
    });
  }

  /** Run on every lock — used to wipe secrets that left the vault (clipboard). */
  onLock = (handler: () => void): (() => void) => {
    this.#lockHandlers.add(handler);
    return () => this.#lockHandlers.delete(handler);
  };

  lock = (): void => {
    this.#vaultKey = null;
    this.#zeroRaw();
    this.#pendingVaultKey = null;
    this.#body = emptyBody();
    if (this.#ephemeral) {
      this.#header = null;
      this.#ephemeral = false;
    }
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    for (const handler of this.#lockHandlers) handler();
    this.#emit();
  };

  isUnlocked(): boolean {
    return this.#vaultKey !== null;
  }

  async changeMasterPassword(
    current: string,
    next: string,
    hint?: string,
  ): Promise<void> {
    if (!this.#header) throw new Error("There is no vault to re-key.");
    if (!this.#header.wrap || !this.#header.kdf) {
      throw new Error(
        "This vault has no master password. Add one under Unlock methods first.",
      );
    }
    assertMasterPasswordPolicy(next);
    const header = await rewrapVaultKey(this.#header, current, next, hint);
    await this.#persistHeader(header);
  }

  // —— persistence ——————————————————————————————————————————

  async #persist(): Promise<void> {
    if (!this.#vaultKey) throw new Error("The vault is locked.");
    // Sealed with the next revision, but memory only takes it once the write
    // lands. Counting first and then failing would leave the body behind the
    // header, and the vault would read as rolled back on the next unlock.
    const rev = (this.#body.rev ?? 0) + 1;
    const sealed = await sealJson(this.#vaultKey, { ...this.#body, rev });
    assertSealed(sealed);
    // Awaited, so a disk that refuses the write reaches `#mutate`'s rollback
    // instead of leaving memory ahead of what survives a reload.
    await kvSetDurable(this.#keys.body, JSON.stringify(sealed));
    this.#body.rev = rev;
    await this.#recordBodyRev(rev);
    // Recoverability (ADR 0039): sealed ciphertext must leave the device for
    // Host → outbox → GitHub. Local OPFS already succeeded; Host failure queues.
    const headerJson = kvGet(this.#keys.header);
    if (headerJson) {
      await pushSealedVaultToHost({
        headerJson,
        bodyJson: JSON.stringify(sealed),
        epoch: rev,
      });
    }
  }

  /** Merge a complete newer Host snapshot while both bodies are authenticated. */
  async mergeHostSnapshot(input: {
    headerJson: string;
    bodyJson: string;
    epoch: number;
  }): Promise<void> {
    const { vaultKey, header } = this.#requireUnlocked();
    let remoteHeader: VaultHeader;
    let sealed: SealedBlob;
    try {
      remoteHeader = overlapCast(JSON.parse(input.headerJson));
      sealed = overlapCast(JSON.parse(input.bodyJson));
    } catch {
      throw new VaultCorruptError("Host vault snapshot is not valid JSON");
    }
    if (
      remoteHeader.v !== 1 ||
      remoteHeader.createdAt !== header.createdAt ||
      !sealed.ivB64 ||
      !sealed.ctB64
    ) {
      throw new VaultCorruptError(
        "Host vault snapshot belongs to another vault",
      );
    }
    const incoming = await openJson<VaultBody>(vaultKey, sealed);
    if (
      incoming.v !== 1 ||
      !Array.isArray(incoming.items) ||
      !Array.isArray(incoming.folders)
    ) {
      throw new VaultCorruptError("Host vault body is malformed");
    }
    if ((incoming.rev ?? 0) !== input.epoch) {
      throw new VaultCorruptError("Host vault epoch does not match its body");
    }
    const merged = mergeVaultBodies(this.#body, incoming);
    await this.#mutate((body) => {
      body.items = merged.items;
      body.folders = merged.folders;
      body.rev = merged.rev;
    });
  }

  /**
   * Note in the header how far the body has got. Written after the body, never
   * before: trailing by one is harmless — the body is simply newer — while
   * leading by one would accuse an intact vault of having been rolled back.
   */
  async #recordBodyRev(rev: number): Promise<void> {
    const header = this.#header;
    if (!header || (header.bodyRev ?? 0) >= rev) return;
    const next: VaultHeader = { ...header, bodyRev: rev };
    this.#header = next;
    try {
      await kvSetDurable(this.#keys.header, JSON.stringify(next));
    } catch {
      // The body is safely stored; only the rollback witness is behind. Losing
      // it costs detection, not data, and the next write will catch it up.
      this.#header = header;
    }
  }

  /**
   * Apply a mutation and seal it. Writes are chained so rapid edits (folder
   * rename on every keystroke) persist in the order they were requested.
   */
  async #mutate(change: (body: VaultBody) => void): Promise<void> {
    const run = this.#writeChain.then(async () => {
      if (!this.#vaultKey) throw new Error("The vault is locked.");
      // Keep the pre-change body so a failed seal or write cannot leave memory
      // ahead of what is on disk.
      const previous: VaultBody = {
        v: this.#body.v,
        items: this.#body.items,
        folders: this.#body.folders,
        ...(this.#body.rev !== undefined ? { rev: this.#body.rev } : undefined),
      };
      change(this.#body);
      try {
        await this.#persist();
      } catch (error) {
        this.#body = previous;
        this.#emit();
        throw error;
      }
      this.touch();
      this.#emit();
    });
    this.#writeChain = run.catch(() => undefined);
    return run;
  }

  // —— items ————————————————————————————————————————————————

  async saveItem(item: VaultItem): Promise<void> {
    await this.#mutate((body) => {
      const next = { ...item, updatedAt: new Date().toISOString() };
      const index = body.items.findIndex(
        (candidate) => candidate.id === item.id,
      );
      if (index === -1) body.items = [...body.items, next];
      else body.items = body.items.map((c, i) => (i === index ? next : c));
    });
  }

  async trashItem(id: string): Promise<void> {
    await this.#mutate((body) => {
      body.items = body.items.map((item) =>
        item.id === id
          ? { ...item, deletedAt: new Date().toISOString() }
          : item,
      );
    });
  }

  async restoreItem(id: string): Promise<void> {
    await this.#mutate((body) => {
      body.items = body.items.map((item) =>
        item.id === id ? { ...item, deletedAt: null } : item,
      );
    });
  }

  async purgeItem(id: string): Promise<void> {
    await this.#mutate((body) => {
      body.items = body.items.filter((item) => item.id !== id);
    });
  }

  async emptyTrash(): Promise<void> {
    await this.#mutate((body) => {
      body.items = body.items.filter((item) => item.deletedAt === null);
    });
  }

  async toggleFavorite(id: string): Promise<void> {
    await this.#mutate((body) => {
      body.items = body.items.map((item) =>
        item.id === id ? { ...item, favorite: !item.favorite } : item,
      );
    });
  }

  async replaceAll(items: VaultItem[], folders: Folder[]): Promise<void> {
    await this.#mutate((body) => {
      body.items = items;
      body.folders = folders;
    });
  }

  async addItems(items: VaultItem[]): Promise<void> {
    await this.#mutate((body) => {
      body.items = [...body.items, ...items];
    });
  }

  /**
   * Apply a manifest merge plan (see `planManifestMerge`): adds, in-place
   * updates, and their folders land in one mutation so a failed write cannot
   * apply half a manifest.
   */
  async applyManifestMerge(plan: {
    adds: VaultItem[];
    updates: VaultItem[];
    newFolders: Folder[];
  }): Promise<void> {
    if (
      plan.adds.length === 0 &&
      plan.updates.length === 0 &&
      plan.newFolders.length === 0
    ) {
      return;
    }
    await this.#mutate((body) => {
      body.folders = [...body.folders, ...plan.newFolders];
      const now = new Date().toISOString();
      const updated = new Map(
        plan.updates.map((item) => [item.id, { ...item, updatedAt: now }]),
      );
      body.items = [
        ...body.items.map((item) => updated.get(item.id) ?? item),
        ...plan.adds,
      ];
    });
  }

  /**
   * Apply an import plan. Items and their new folders land in one mutation, so
   * a failed write cannot leave folders behind with nothing in them.
   */
  async applyImport(plan: {
    items: VaultItem[];
    newFolders: Folder[];
  }): Promise<number> {
    if (plan.items.length === 0 && plan.newFolders.length === 0) return 0;
    await this.#mutate((body) => {
      body.folders = [...body.folders, ...plan.newFolders];
      body.items = [...body.items, ...plan.items];
    });
    return plan.items.length;
  }

  // —— folders ——————————————————————————————————————————————

  async addFolder(name: string): Promise<Folder> {
    const folder: Folder = {
      id: crypto.randomUUID(),
      name: name.trim(),
      createdAt: new Date().toISOString(),
    };
    await this.#mutate((body) => {
      body.folders = [...body.folders, folder];
    });
    return folder;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    await this.#mutate((body) => {
      body.folders = body.folders.map((folder) =>
        folder.id === id ? { ...folder, name: name.trim() } : folder,
      );
    });
  }

  async deleteFolder(id: string): Promise<void> {
    await this.#mutate((body) => {
      body.folders = body.folders.filter((folder) => folder.id !== id);
      body.items = body.items.map((item) =>
        item.folderId === id ? { ...item, folderId: null } : item,
      );
    });
  }

  // —— export / import ——————————————————————————————————————

  /** Encrypted export — the sealed body plus its header, portable to another device. */
  exportSealed(): string {
    if (!this.#header) throw new Error("There is no vault to export.");
    const body = kvGet(this.#keys.body);
    if (!body) throw new Error("There is nothing stored to export yet.");
    return JSON.stringify(
      {
        format: "opensesame-vault-export",
        v: 1,
        exportedAt: new Date().toISOString(),
        header: this.#header,
        body: overlapCast(JSON.parse(body)),
      },
      null,
      2,
    );
  }

  /** Import a sealed export using the master password it was sealed under. */
  async importSealed(fileText: string, password: string): Promise<number> {
    let parsed: {
      format?: string;
      header?: VaultHeader;
      body?: SealedBlob;
    };
    try {
      parsed = overlapCast(JSON.parse(fileText));
    } catch {
      throw new Error("That file is not valid JSON.");
    }
    if (
      parsed.format !== "opensesame-vault-export" ||
      !parsed.header ||
      !parsed.body
    ) {
      throw new Error("That file is not an OpenSesame vault export.");
    }
    if (!parsed.header.wrap || !parsed.header.kdf) {
      throw new Error(
        "That export has no master-password unlock. Re-export from a vault that still has a password enrolled, or unlock the source vault and merge items another way.",
      );
    }
    const raw = await unwrapRawVaultKeyFromPassword(parsed.header, password);
    const key = await importVaultKey(raw);
    raw.fill(0);
    const incoming = await openJson<VaultBody>(key, parsed.body);

    if (!this.#vaultKey) throw new Error("Unlock this vault before importing.");
    const existing = new Set(this.#body.items.map((item) => item.id));
    const merged = (incoming.items ?? []).filter(
      (item) => !existing.has(item.id),
    );
    const folderIds = new Set(this.#body.folders.map((folder) => folder.id));
    const mergedFolders = (incoming.folders ?? []).filter(
      (folder) => !folderIds.has(folder.id),
    );
    await this.#mutate((body) => {
      body.items = [...body.items, ...merged];
      body.folders = [...body.folders, ...mergedFolders];
    });
    return merged.length;
  }

  /** Irreversibly remove the vault from this device. */
  async destroy(): Promise<void> {
    // Deleting is at least as final as locking, so it runs the same teardown:
    // clipboard, Identity session, staged claims.
    this.lock();
    this.#header = null;
    this.#emit();
    // Queued behind any write still in the air. Deleting straight away would let
    // a persist that had already sealed its body land afterwards and put the
    // vault — ciphertext, header and all — back on a device it was deleted from.
    const done = this.#writeChain
      .catch(() => undefined)
      .then(async () => {
        // Awaited, so this resolves only once the files are actually gone.
        await Promise.all([
          kvDeleteDurable(this.#keys.header),
          kvDeleteDurable(this.#keys.body),
          kvDeleteDurable(this.#keys.attempts),
        ]);
      });
    this.#writeChain = done;
    await done;
    this.#emit();
  }

  // —— preferences and auto-lock ————————————————————————————

  setPrefs(next: Partial<VaultPrefs>): void {
    this.#prefs = normalizeVaultPrefs({
      ...this.#prefs,
      ...next,
      prefsRevision: VAULT_PREFS_REVISION,
    });
    kvSet(this.#keys.prefs, JSON.stringify(this.#prefs));
    this.#armIdleTimer();
    this.#emit();
  }

  touch = (): void => {
    this.#lastActivity = Date.now();
  };

  #armIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    if (!this.#vaultKey || this.#prefs.autoLockMinutes <= 0) return;
    const windowMs = this.#prefs.autoLockMinutes * 60_000;
    const tick = () => {
      const idleFor = Date.now() - this.#lastActivity;
      if (idleFor >= windowMs) {
        this.lock();
        return;
      }
      this.#idleTimer = setTimeout(tick, Math.max(1_000, windowMs - idleFor));
    };
    this.#idleTimer = setTimeout(tick, windowMs);
  }
}

export const vaultStore = new VaultStore();

hostBackupSeams.mergePulledVault = (input) =>
  vaultStore.mergeHostSnapshot(input);

export { WrongPasswordError, VaultCorruptError };
