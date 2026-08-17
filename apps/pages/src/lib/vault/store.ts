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
  openJson,
  rewrapVaultKey,
  sealJson,
  unlockVaultKey,
  wrapVaultKeyWithPassword,
} from "./crypto.js";
import {
  type Folder,
  type VaultBody,
  type VaultItem,
  emptyBody,
} from "./model.js";
import { estimateStrength } from "./password.js";
import { totpSetupUri } from "./totp.js";
import {
  type VaultUnlocks,
  assertKeepsPrimaryUnlock,
  assertPinPolicy,
  createPasskeyUnlockCeremony,
  exportRawVaultKey,
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

/**
 * Base key names. The store reads and writes them through the active
 * project's scope (`scopedKey`), so each project keeps its own sealed vault.
 */
export const HEADER_KEY = "vault.header.v1";
export const BODY_KEY = "vault.body.v1";
export const ATTEMPTS_KEY = "vault.attempts.v1";
export const PREFS_KEY = "vault.prefs.v1";

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
  /** Seconds before a copied secret is cleared from the clipboard. 0 disables. */
  clipboardClearSeconds: number;
  theme: "system" | "light" | "dark";
};

export const defaultPrefs: VaultPrefs = {
  autoLockMinutes: 15,
  lockOnHide: false,
  clipboardClearSeconds: 30,
  theme: "system",
};

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
    return JSON.parse(raw) as T;
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

  constructor() {
    this.#header = readJson<VaultHeader | null>(this.#keys.header, null);
    this.#prefs = {
      ...defaultPrefs,
      ...readJson<Partial<VaultPrefs>>(this.#keys.prefs, {}),
    };
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
    this.#prefs = {
      ...defaultPrefs,
      ...readJson<Partial<VaultPrefs>>(this.#keys.prefs, {}),
    };
    this.#emit();
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

  async create(password: string, hint?: string): Promise<void> {
    assertMasterPasswordPolicy(password);
    const { header, vaultKey } = await createVault(password, hint);
    this.#header = header;
    this.#vaultKey = vaultKey;
    this.#pendingVaultKey = null;
    this.#body = emptyBody();
    try {
      await kvSetDurable(this.#keys.header, JSON.stringify(header));
      await this.#persist();
    } catch (error) {
      // A vault whose header never reached disk cannot be unlocked again, so
      // leave nothing behind that would claim otherwise.
      this.#header = null;
      this.#vaultKey = null;
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

    let vaultKey: CryptoKey;
    try {
      vaultKey = await unlockVaultKey(this.#header, password);
    } catch (error) {
      if (!(error instanceof WrongPasswordError)) throw error;
      this.#recordFailedUnlock();
      throw error;
    }
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
    const vaultKey = await importVaultKey(raw);
    raw.fill(0);
    await this.#afterPrimaryUnwrap(vaultKey);
  }

  async unlockWithPasskey(): Promise<void> {
    this.#assertNotLockedOut();
    if (!this.#header) throw new Error("There is no vault on this device yet.");
    const record = this.#header.unlocks?.passkey;
    if (!record) throw new Error("This vault has no passkey unlock.");

    let prfOutput: ArrayBuffer;
    try {
      prfOutput = await getPasskeyUnlockCeremony(record, webauthnRpId());
    } catch (error) {
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
    const vaultKey = await importVaultKey(raw);
    raw.fill(0);
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
    this.#emit();
  }

  #requireUnlocked(): { vaultKey: CryptoKey; header: VaultHeader } {
    if (!this.#vaultKey || !this.#header) {
      throw new Error("Unlock the vault before changing unlock methods.");
    }
    return { vaultKey: this.#vaultKey, header: this.#header };
  }

  async enrollPasskey(): Promise<void> {
    const { vaultKey, header } = this.#requireUnlocked();
    const raw = await exportRawVaultKey(vaultKey);
    try {
      const ceremony = await createPasskeyUnlockCeremony(webauthnRpId());
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
    } finally {
      raw.fill(0);
    }
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
    const { vaultKey, header } = this.#requireUnlocked();
    assertPinPolicy(pin);
    const raw = await exportRawVaultKey(vaultKey);
    try {
      const record = await wrapVaultKeyWithPin(raw, pin);
      const unlocks: VaultUnlocks = {
        ...header.unlocks,
        pin: record,
      };
      await this.#persistHeader({ ...header, unlocks });
    } finally {
      raw.fill(0);
    }
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
    const { vaultKey, header } = this.#requireUnlocked();
    assertMasterPasswordPolicy(password);
    const raw = await exportRawVaultKey(vaultKey);
    try {
      const { kdf, wrap } = await wrapVaultKeyWithPassword(raw, password);
      await this.#persistHeader({ ...header, kdf, wrap });
    } finally {
      raw.fill(0);
    }
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
    this.#pendingVaultKey = null;
    this.#body = emptyBody();
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
        ...(this.#body.rev !== undefined ? { rev: this.#body.rev } : {}),
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
        body: JSON.parse(body) as SealedBlob,
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
      parsed = JSON.parse(fileText) as typeof parsed;
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
    const key = await unlockVaultKey(parsed.header, password);
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
    this.#prefs = { ...this.#prefs, ...next };
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

export { WrongPasswordError, VaultCorruptError };
