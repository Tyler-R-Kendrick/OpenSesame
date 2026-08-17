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
import {
  type SealedBlob,
  VaultCorruptError,
  type VaultHeader,
  WrongPasswordError,
  assertSealed,
  createVault,
  openJson,
  rewrapVaultKey,
  sealJson,
  unlockVaultKey,
} from "./crypto.js";
import {
  type Folder,
  type VaultBody,
  type VaultItem,
  emptyBody,
} from "./model.js";
import { estimateStrength } from "./password.js";

export const HEADER_KEY = "vault.header.v1";
export const BODY_KEY = "vault.body.v1";
export const ATTEMPTS_KEY = "vault.attempts.v1";
export const PREFS_KEY = "vault.prefs.v1";

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

  constructor() {
    this.#header = readJson<VaultHeader | null>(HEADER_KEY, null);
    this.#prefs = {
      ...defaultPrefs,
      ...readJson<Partial<VaultPrefs>>(PREFS_KEY, {}),
    };
    this.#snapshot = this.#build();
  }

  /** Re-read plaintext state once OPFS hydration has filled the KV cache. */
  rehydrate(): void {
    if (this.#vaultKey) return;
    this.#header = readJson<VaultHeader | null>(HEADER_KEY, null);
    this.#prefs = {
      ...defaultPrefs,
      ...readJson<Partial<VaultPrefs>>(PREFS_KEY, {}),
    };
    this.#emit();
  }

  #build(): VaultState {
    const attempts = readJson<{ fails: number; until: number }>(ATTEMPTS_KEY, {
      fails: 0,
      until: 0,
    });
    return {
      status: this.#vaultKey ? "unlocked" : this.#header ? "locked" : "empty",
      header: this.#header,
      items: this.#body.items,
      folders: this.#body.folders,
      prefs: this.#prefs,
      lockedOutUntil: attempts.until > Date.now() ? attempts.until : null,
      failedAttempts: attempts.fails,
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
    this.#body = emptyBody();
    try {
      await kvSetDurable(HEADER_KEY, JSON.stringify(header));
      await this.#persist();
    } catch (error) {
      // A vault whose header never reached disk cannot be unlocked again, so
      // leave nothing behind that would claim otherwise.
      this.#header = null;
      this.#vaultKey = null;
      this.#body = emptyBody();
      kvDelete(HEADER_KEY);
      kvDelete(BODY_KEY);
      this.#emit();
      throw error;
    }
    kvDelete(ATTEMPTS_KEY);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
  }

  async unlock(password: string): Promise<void> {
    const attempts = readJson<{ fails: number; until: number }>(ATTEMPTS_KEY, {
      fails: 0,
      until: 0,
    });
    if (attempts.until > Date.now()) {
      const seconds = Math.ceil((attempts.until - Date.now()) / 1000);
      throw new Error(`Too many attempts. Try again in ${seconds}s.`);
    }
    if (!this.#header) throw new Error("There is no vault on this device yet.");

    let vaultKey: CryptoKey;
    try {
      vaultKey = await unlockVaultKey(this.#header, password);
    } catch (error) {
      // Only a wrong password counts. A corrupt or unsupported header fails for
      // every password, so counting it would lock the user out of a vault no
      // password can open.
      if (!(error instanceof WrongPasswordError)) throw error;
      const fails = attempts.fails + 1;
      const until =
        fails >= LOCK_AFTER_FAILS
          ? Date.now() +
            Math.min(
              BASE_LOCKOUT_MS * 2 ** (fails - LOCK_AFTER_FAILS),
              MAX_LOCKOUT_MS,
            )
          : 0;
      kvSet(ATTEMPTS_KEY, JSON.stringify({ fails, until }));
      this.#emit();
      throw error;
    }

    this.#vaultKey = vaultKey;
    const sealed = readJson<SealedBlob | null>(BODY_KEY, null);
    if (sealed) {
      try {
        const body = await openJson<VaultBody>(vaultKey, sealed);
        // The revision is sealed with the body, so only the vault key can move
        // it. Behind what the header last saw means this file is an older copy —
        // a restored backup, a synced-over write — and opening it silently would
        // hand back passwords that were changed and items that were deleted.
        const rev = body.rev ?? 0;
        if (rev < (this.#header?.bodyRev ?? 0)) {
          throw new VaultCorruptError(
            "this vault file is older than the last write recorded on this device. " +
              "If you restored a backup, import it from Settings instead; " +
              "the vault here was not opened, so nothing has been lost yet",
          );
        }
        this.#body = {
          v: 1,
          items: body.items ?? [],
          folders: body.folders ?? [],
          rev,
        };
      } catch (error) {
        this.#vaultKey = null;
        throw error instanceof VaultCorruptError
          ? error
          : new VaultCorruptError("unreadable body");
      }
    } else {
      this.#body = emptyBody();
    }
    kvDelete(ATTEMPTS_KEY);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
  }

  /** Run on every lock — used to wipe secrets that left the vault (clipboard). */
  onLock = (handler: () => void): (() => void) => {
    this.#lockHandlers.add(handler);
    return () => this.#lockHandlers.delete(handler);
  };

  lock = (): void => {
    this.#vaultKey = null;
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
    assertMasterPasswordPolicy(next);
    const header = await rewrapVaultKey(this.#header, current, next, hint);
    const previous = this.#header;
    this.#header = header;
    try {
      await kvSetDurable(HEADER_KEY, JSON.stringify(header));
    } catch (error) {
      // The vault key is unchanged, so the old password still opens what is on
      // disk. Saying otherwise would lock the owner out of their own vault.
      this.#header = previous;
      this.#emit();
      throw error;
    }
    this.#emit();
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
    await kvSetDurable(BODY_KEY, JSON.stringify(sealed));
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
      await kvSetDurable(HEADER_KEY, JSON.stringify(next));
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
    const body = kvGet(BODY_KEY);
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
          kvDeleteDurable(HEADER_KEY),
          kvDeleteDurable(BODY_KEY),
          kvDeleteDurable(ATTEMPTS_KEY),
        ]);
      });
    this.#writeChain = done;
    await done;
    this.#emit();
  }

  // —— preferences and auto-lock ————————————————————————————

  setPrefs(next: Partial<VaultPrefs>): void {
    this.#prefs = { ...this.#prefs, ...next };
    kvSet(PREFS_KEY, JSON.stringify(this.#prefs));
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
