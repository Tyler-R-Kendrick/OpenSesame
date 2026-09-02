import { isBoolean, isNumber, overlapCast } from "@opensesame/os-domain";
/**
 * Vault session store. Holds the unlocked collection in memory, seals every
 * mutation straight back to OPFS, and drops the key on lock.
 *
 * Tomb framing (ADR 0063): every vault is a tomb in the encrypted VFS
 * (`lib/vfs.ts`). The active project's vault lives at `tomb/<name>/body`
 * (store-sealed, verbatim) with its plaintext params header at
 * `tomb/<name>/header`; the personal vault is the `personal` tomb
 * (ADR 0038). Vault prefs moved into the sealed tomb config — they hydrate
 * on unlock and are unreadable while locked. Lockout counters stay
 * plaintext at their scoped key by design (documented boundary).
 */

import {
  kvDelete,
  kvDeleteDurable,
  kvDurability,
  kvGet,
  kvSet,
} from "../kv.js";
import {
  activeProject,
  carryProjectsViewInto,
  projectsState,
  scopedKey,
} from "../projects.js";
import {
  BODY_PATH,
  HEADER_PATH,
  VfsError,
  deleteFile,
  deletePlaintextFile,
  listTombs,
  lockTomb,
  readFile,
  readPlaintextFile,
  readSealedFile,
  unlockTomb,
  writeFile,
  writePlaintextFile,
  writeSealedFile,
} from "../vfs.js";
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
  type InstallResult,
  installItemType,
  installedDefinitions,
  syncInstalledTypes,
  uninstallItemType,
} from "./item-types.js";
import {
  type Folder,
  type VaultBody,
  type VaultItem,
  emptyBody,
  mergeVaultBodies,
} from "./model.js";
import { estimateStrength } from "./password.js";
import { type SentCode, sendCode, verifyCode } from "./remote-code.js";
import {
  discardTombCaches,
  hydrateAndMigrateTombOnUnlock,
  wipeTombOnDestroy,
} from "./tomb-migration.js";
import { totpSetupUri } from "./totp.js";
import {
  type CodeChannel,
  RECOVERY_CODE_COUNT,
  type RecoveryLedger,
  type VaultUnlocks,
  assertKeepsPrimaryUnlock,
  assertPinPolicy,
  createPasskeyUnlockCeremony,
  getPasskeyUnlockCeremony,
  hasSecondStep,
  normalizeRecoveryCode,
  openRecoveryLedger,
  openText,
  openTotpSecret,
  primaryUnlockCount,
  randomRecoveryCodes,
  randomTotpSecret,
  sealRecoveryLedger,
  sealText,
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
 * Lockout counters stay plaintext at their project-scoped KV key — the
 * documented ADR 0063 boundary: they gate unlock attempts, so they must be
 * readable and writable while the tomb is locked.
 */
export const ATTEMPTS_KEY = "vault.attempts.v1";

/** Sealed VFS path (within a tomb) holding the vault prefs JSON. */
export const PREFS_CONFIG_PATH = "config/prefs";

type VaultScope = {
  /** The active project vault's tomb — the project id, `personal` for the base vault. */
  tomb: string;
  attempts: string;
};

function scopedVaultScope(): VaultScope {
  return {
    tomb: activeProject().id,
    attempts: scopedKey(ATTEMPTS_KEY),
  };
}

/**
 * The tomb a guest session uses when a sealed vault already lives in the
 * active scope. Guest beside an existing vault must never touch that vault:
 * it is a separate, throwaway tomb with no header, so nothing a guest writes
 * can land on the real body, and nothing pushes to the Host (no header, no
 * snapshot). Not a project id — those are random ids or `personal`.
 */
export const GUEST_TOMB = "guest";

function guestVaultScope(): VaultScope {
  return {
    tomb: GUEST_TOMB,
    attempts: `${ATTEMPTS_KEY}.${GUEST_TOMB}`,
  };
}

export type VaultStatus = "empty" | "locked" | "unlocked";

/**
 * A tomb's plaintext header, or null when nothing was ever sealed there (or
 * the file is unreadable — treated the same: nothing to unlock). Public
 * parameters only, the documented ADR 0063 boundary; the vault switcher reads
 * these for every tomb on the device to say when each was sealed.
 */
/**
 * Whether any tomb on this device holds a sealed vault. The guest road
 * isolates itself whenever one does — a guest must never end up sealing the
 * tomb of a project that was created but not yet given its own key.
 */
export function deviceHoldsSealedVault(): boolean {
  return listTombs().some((tomb) => readTombHeader(tomb) !== null);
}

/**
 * Whether two headers carry an identical wrap record — the same password
 * wrap and derivation, the same PIN record, or the same passkey record. A
 * project forked "with this vault's key" starts with every record equal;
 * enrolling another method on one side leaves the shared ones intact, so
 * one identical record is enough to predict a shared key. It is a
 * prediction: opening the sealed body is the proof.
 */
export function sharesWrapRecord(a: VaultHeader, b: VaultHeader): boolean {
  const same = (x: unknown, y: unknown) =>
    x !== undefined &&
    y !== undefined &&
    x !== null &&
    y !== null &&
    JSON.stringify(x) === JSON.stringify(y);
  if (same(a.wrap, b.wrap) && same(a.kdf, b.kdf)) return true;
  if (same(a.unlocks?.pin, b.unlocks?.pin)) return true;
  if (same(a.unlocks?.passkey, b.unlocks?.passkey)) return true;
  return false;
}

export function readTombHeader(tomb: string): VaultHeader | null {
  const raw = readPlaintextFile(tomb, HEADER_PATH);
  if (!raw) return null;
  try {
    return overlapCast(JSON.parse(raw));
  } catch {
    return null;
  }
}

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
  /** The tomb this session is scoped to — a project id, `personal`, or `guest`. */
  tomb: string;
  /** True while a guest session holds the key: never wrapped to disk. */
  guest: boolean;
  header: VaultHeader | null;
  items: VaultItem[];
  folders: Folder[];
  prefs: VaultPrefs;
  /** Milliseconds until auto-lock, or null when no timer is armed. */
  lockedOutUntil: number | null;
  failedAttempts: number;
  /**
   * True after a primary unlock (password / PIN / passkey) when a second step
   * (authenticator, email or text code) is enrolled and none has been
   * confirmed yet. The key is parked in memory until one is.
   */
  awaitingSecondStep: boolean;
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
  /** A seed offered for enrollment; discarded unless a code confirms it. */
  #pendingTotpSecret: string | null = null;
  /** A code the Identity API sent and has not yet been asked about. */
  #pendingCode: SentCode | null = null;
  /** The address a code enrollment is confirming, until its first code matches. */
  #pendingCodeAddress: { channel: CodeChannel; to: string } | null = null;
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
  #scope: VaultScope = scopedVaultScope();
  /**
   * Guest / this-tab vault: the key was never wrapped to disk. Locking or
   * reloading must not leave a wrap-less header that cannot be unlocked.
   */
  #ephemeral = false;

  constructor() {
    this.#header = this.#readHeader();
    this.#snapshot = this.#build();
  }

  /**
   * Re-read plaintext state once OPFS hydration has filled the KV cache.
   * Hydration is also when the active project becomes known, so the tomb
   * scope is recomputed here before anything is read. Prefs stay defaults
   * until unlock — they live in the sealed tomb config now.
   */
  rehydrate(): void {
    if (this.#vaultKey || this.#pendingVaultKey) return;
    this.#scope = scopedVaultScope();
    this.#header = this.#readHeader();
    this.#emit();
  }

  /**
   * Drop the previous project's session and read the active project's header.
   * Identity stays signed in — this is a vault-scope swap, not a reload.
   */
  loadActiveProjectScope(): void {
    this.lock();
    this.#scope = scopedVaultScope();
    this.#header = this.#readHeader();
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
    // A guest holds a key that was never wrapped to disk: forking it would
    // seal a tomb no passkey, PIN or password can ever open.
    if (this.#ephemeral) {
      throw new Error("A guest session has no key to share.");
    }
    this.#scope = scopedVaultScope();
    unlockTomb(this.#scope.tomb, this.#vaultKey);
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
    await writePlaintextFile(
      this.#scope.tomb,
      HEADER_PATH,
      JSON.stringify(header),
    );
    this.#persistPrefs();
    await this.#persist();
    // The new tomb's own projects view, sealed now, so its name never has to
    // ride in memory or fall back to its id after a lock.
    await carryProjectsViewInto(this.#scope.tomb, projectsState());
    this.touch();
    this.#armIdleTimer();
    this.#emit();
  }

  /** The tomb this session is scoped to. */
  activeTomb(): string {
    return this.#scope.tomb;
  }

  /**
   * Whether `other` was sealed with this session's key — the header a
   * project gets from `forkUnlockedIntoActiveScope` carries the same wrap
   * material verbatim, so an equal wrap is the proof, not a name or a flag.
   * False while locked: without a session there is nothing to share.
   */
  sharesKeyWith(other: VaultHeader | null): boolean {
    if (!this.#vaultKey || !this.#header || !other) return false;
    if (this.#ephemeral) return false;
    return sharesWrapRecord(this.#header, other);
  }

  /**
   * Swap into the active project's tomb and open it with the key already in
   * hand — the road a shared-key project takes, so a person who sealed
   * "Work" with their personal key is not asked for that key again.
   *
   * The target's header must share this session's wrap material
   * (`sharesKeyWith`); anything else throws before the scope moves, and the
   * caller falls back to a plain lock-and-unlock. The previous tomb locks
   * first: two tombs are never open in one session.
   */
  async openActiveScopeWithCurrentKey(): Promise<void> {
    const vaultKey = this.#vaultKey;
    if (!vaultKey || !this.#header || this.#ephemeral) {
      throw new Error("Unlock the vault before carrying it into another.");
    }
    const next = scopedVaultScope();
    const header = readTombHeader(next.tomb);
    if (!header) {
      throw new Error("That vault has not been sealed yet.");
    }
    // The header comparison is the cheap, sync prediction the switcher shows;
    // the proof is opening the target's sealed body with the key in hand. A
    // tomb with no body yet has nothing to prove against, so the prediction
    // is the gate there.
    if (
      readSealedFile(next.tomb, BODY_PATH) === null &&
      !sharesWrapRecord(this.#header, header)
    ) {
      throw new Error("That vault was sealed with a different key.");
    }
    // A vault whose unlock methods drifted from its sibling's still opens
    // when the key is the same, and a matching header never opens a body
    // sealed under a different one.
    const previous = {
      scope: this.#scope,
      header: this.#header,
      body: this.#body,
      projects: projectsState(),
    };
    for (const handler of this.#lockHandlers) handler();
    lockTomb(previous.scope.tomb);
    discardTombCaches();
    this.#scope = next;
    this.#header = header;
    this.#body = emptyBody();
    try {
      await this.#activateSession(vaultKey);
    } catch (error) {
      // Back where we were, key intact: the swap never happened.
      lockTomb(next.tomb);
      this.#scope = previous.scope;
      this.#header = previous.header;
      this.#body = previous.body;
      this.#vaultKey = vaultKey;
      unlockTomb(previous.scope.tomb, vaultKey);
      await hydrateAndMigrateTombOnUnlock(previous.scope.tomb).catch(
        () => undefined,
      );
      this.#emit();
      throw error instanceof VaultCorruptError
        ? new Error("That vault was sealed with a different key.")
        : error;
    }
    await carryProjectsViewInto(next.tomb, previous.projects);
  }

  #readHeader(): VaultHeader | null {
    return readTombHeader(this.#scope.tomb);
  }

  /**
   * Write-through the in-memory prefs to the sealed tomb config. Fire and
   * forget like the legacy kvSet: memory is the session's source of truth.
   */
  #persistPrefs(): void {
    if (!this.#vaultKey) return;
    void writeFile(
      this.#scope.tomb,
      PREFS_CONFIG_PATH,
      new TextEncoder().encode(JSON.stringify(this.#prefs)),
    ).catch(() => {
      /* memory holds the session's prefs; the next unlock re-reads */
    });
  }

  /** Hydrate prefs from the sealed tomb config on unlock. */
  async #loadPrefsFromVfs(): Promise<void> {
    try {
      const bytes = await readFile(this.#scope.tomb, PREFS_CONFIG_PATH);
      const stored: Partial<VaultPrefs> = overlapCast(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      const needsMigration = (stored.prefsRevision ?? 0) < VAULT_PREFS_REVISION;
      this.#prefs = normalizeVaultPrefs(stored);
      if (needsMigration) {
        // Awaited — the one-time revision migration must be durable, not
        // racing whatever the session does next.
        await writeFile(
          this.#scope.tomb,
          PREFS_CONFIG_PATH,
          new TextEncoder().encode(JSON.stringify(this.#prefs)),
        ).catch(() => {
          /* memory holds the session's prefs; the next unlock re-reads */
        });
      }
    } catch (error) {
      if (error instanceof VfsError && error.code === "locked") throw error;
      // No prefs file (or an unreadable one): defaults stand.
    }
  }

  #build(): VaultState {
    const attempts = readJson<{ fails: number; until: number }>(
      this.#scope.attempts,
      {
        fails: 0,
        until: 0,
      },
    );
    return {
      status: this.#vaultKey ? "unlocked" : this.#header ? "locked" : "empty",
      tomb: this.#scope.tomb,
      guest: this.#ephemeral && this.#vaultKey !== null,
      header: this.#header,
      items: this.#body.items,
      folders: this.#body.folders,
      prefs: this.#prefs,
      lockedOutUntil: attempts.until > Date.now() ? attempts.until : null,
      failedAttempts: attempts.fails,
      awaitingSecondStep:
        this.#pendingVaultKey !== null && this.#vaultKey === null,
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
   * Guest session: no passkey, PIN, or password. The vault key lives in this
   * tab only until an unlock method is enrolled.
   *
   * On a first run the guest lives in the active tomb, so enrolling an unlock
   * method later seals it in place. Beside a sealed vault it moves to the
   * isolated guest tomb instead (see `GUEST_TOMB`): the existing vault stays
   * exactly as it was on disk, and `lock()` brings it back on screen. Guest
   * is never withheld because a vault exists — that was the bug (AGENTS.md
   * §5), and isolation is the fix, not suppression.
   */
  async createGuest(): Promise<void> {
    if (this.#vaultKey || this.#pendingVaultKey) {
      throw new Error("Lock the open vault before continuing as a guest.");
    }
    if (this.#header || deviceHoldsSealedVault()) {
      this.#scope = guestVaultScope();
      // Whatever a previous guest left behind is ciphertext under a key that
      // died with its tab — unreadable, and in the way of a fresh session.
      lockTomb(this.#scope.tomb);
      await wipeTombOnDestroy(this.#scope.tomb);
      await deleteFile(this.#scope.tomb, BODY_PATH);
    }
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
    unlockTomb(this.#scope.tomb, vaultKey);
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
    unlockTomb(this.#scope.tomb, vaultKey);
    try {
      await writePlaintextFile(
        this.#scope.tomb,
        HEADER_PATH,
        JSON.stringify(header),
      );
      await this.#persist();
      // Legacy config (prefs, registry, …) still belongs with this tomb —
      // seal it in, then read this session's view of it.
      await hydrateAndMigrateTombOnUnlock(this.#scope.tomb);
      await this.#loadPrefsFromVfs();
    } catch (error) {
      // A vault whose header never reached disk cannot be unlocked again, so
      // leave nothing behind that would claim otherwise.
      this.#header = null;
      this.#vaultKey = null;
      lockTomb(this.#scope.tomb);
      this.#zeroRaw();
      this.#body = emptyBody();
      void deletePlaintextFile(this.#scope.tomb, HEADER_PATH);
      void deleteFile(this.#scope.tomb, BODY_PATH);
      this.#emit();
      throw error;
    }
    kvDelete(this.#scope.attempts);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
  }

  #assertNotLockedOut(): void {
    const attempts = readJson<{ fails: number; until: number }>(
      this.#scope.attempts,
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
      this.#scope.attempts,
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
    kvSet(this.#scope.attempts, JSON.stringify({ fails, until }));
    this.#emit();
  }

  async #loadBody(vaultKey: CryptoKey): Promise<VaultBody> {
    const sealed = readSealedFile(this.#scope.tomb, BODY_PATH);
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
      // The registry is rebuilt from what the body carries, so a definition
      // installed on another device is live here the moment it syncs — no
      // build, no reload (ADR 0087 §7).
      syncInstalledTypes(body.itemTypes);
      return {
        v: 1,
        items: body.items ?? [],
        folders: body.folders ?? [],
        ...(body.itemTypes !== undefined
          ? { itemTypes: body.itemTypes }
          : undefined),
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
    unlockTomb(this.#scope.tomb, vaultKey);
    try {
      // Phase C: seal any legacy plaintext config into this tomb and hydrate
      // every module's view of it, then this session's prefs and body.
      await hydrateAndMigrateTombOnUnlock(this.#scope.tomb);
      await this.#loadPrefsFromVfs();
      this.#body = await this.#loadBody(vaultKey);
    } catch (error) {
      this.#vaultKey = null;
      lockTomb(this.#scope.tomb);
      this.#zeroRaw();
      this.#body = emptyBody();
      throw error;
    }
    kvDelete(this.#scope.attempts);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
  }

  /** After primary unwrap: either activate or park the key for a second step. */
  async #afterPrimaryUnwrap(vaultKey: CryptoKey): Promise<void> {
    if (hasSecondStep(this.#header)) {
      this.#pendingVaultKey = vaultKey;
      this.#emit();
      return;
    }
    await this.#activateSession(vaultKey);
  }

  async unlock(password: string): Promise<void> {
    this.#assertNotLockedOut();
    if (!this.#header) throw new Error("There is no vault on this device yet.");
    // A challenge this vault never enrolled must fail exactly like a wrong
    // secret — same error, same lockout count — or the unlock screen would
    // enumerate which methods this vault uses.
    if (!this.#header.wrap || !this.#header.kdf) {
      this.#recordFailedUnlock();
      throw new WrongPasswordError();
    }

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
    // Unenrolled challenge: fail like a wrong PIN, lockout included (see unlock).
    if (!record) {
      this.#recordFailedUnlock();
      throw new WrongPasswordError("That PIN did not unlock the vault.");
    }

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
    // Unenrolled challenge: fail like a wrong passkey, lockout included (see unlock).
    if (!record) {
      this.#recordFailedUnlock();
      throw new WrongPasswordError("That passkey did not unlock the vault.");
    }

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
    this.#pendingCode = null;
    this.#emit();
  }

  /**
   * Step 2 by email or text: open the sealed address with the key step 1
   * produced and ask the Identity API to send a code there. Returns the
   * masked destination for the screen to name.
   */
  async requestSecondStepCode(channel: CodeChannel): Promise<SentCode> {
    this.#assertNotLockedOut();
    const pending = this.#pendingVaultKey;
    const record = this.#header?.unlocks?.[channel];
    if (!pending || !record) {
      throw new Error("Enter a primary unlock method first.");
    }
    const to = await openText(pending, record.toWrap);
    const sent = await sendCode(channel, to);
    this.#pendingCode = sent;
    this.#emit();
    return sent;
  }

  /** The code the Identity API sent, if one is outstanding at unlock. */
  pendingSecondStepCode(): SentCode | null {
    return this.#pendingCode;
  }

  /**
   * Confirm a code the Identity API sent. The service says yes or no; a no
   * counts toward the lockout exactly as a wrong authenticator code does.
   */
  async confirmRemoteCode(code: string): Promise<void> {
    this.#assertNotLockedOut();
    const pending = this.#pendingVaultKey;
    const sent = this.#pendingCode;
    if (!pending || !sent) {
      throw new Error("Ask for a code first.");
    }
    try {
      await verifyCode(sent.challengeId, code);
    } catch (error) {
      this.#recordFailedUnlock();
      throw error;
    }
    this.#pendingCode = null;
    await this.#activateSession(pending);
  }

  /**
   * A recovery code stands in for the second step once. Its hash is looked
   * up in the ledger sealed under the parked key, marked used, and the ledger
   * is written back before the session opens — a code spent twice is a code
   * someone copied.
   */
  async redeemRecoveryCode(code: string): Promise<void> {
    this.#assertNotLockedOut();
    const pending = this.#pendingVaultKey;
    const header = this.#header;
    const record = header?.unlocks?.recovery;
    if (!pending || !header || !record) {
      throw new WrongPasswordError("That recovery code is not valid.");
    }
    const ledger = await openRecoveryLedger(pending, record);
    const typed = normalizeRecoveryCode(code);
    const index = ledger.codes.findIndex(
      (candidate, i) =>
        typed.length > 0 &&
        normalizeRecoveryCode(candidate) === typed &&
        !ledger.used[i],
    );
    if (index < 0) {
      this.#recordFailedUnlock();
      throw new WrongPasswordError("That recovery code is not valid.");
    }
    const used = ledger.used.map((flag, i) => flag || i === index);
    const codesWrap = await sealRecoveryLedger(pending, {
      codes: ledger.codes,
      used,
    });
    await this.#persistHeader({
      ...header,
      unlocks: { ...header.unlocks, recovery: { ...record, codesWrap } },
    });
    this.#pendingCode = null;
    await this.#activateSession(pending);
  }

  async #persistHeader(next: VaultHeader): Promise<void> {
    const previous = this.#header;
    this.#header = next;
    try {
      await writePlaintextFile(
        this.#scope.tomb,
        HEADER_PATH,
        JSON.stringify(next),
      );
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
   * Start enrolling an authenticator code as the second step after any
   * primary unlock. Returns an otpauth URI for the QR / authenticator app.
   *
   * Nothing is written yet. The gate lands on disk only once
   * `confirmTotpEnrollment` sees a code from the app that matches — an
   * unscanned or mis-scanned seed used to become a gate the moment Enroll was
   * pressed, and the next unlock then asked for a code nobody could produce.
   *
   * It also needs a key to guard: a guest session holds nothing wrapped to
   * disk, and writing `unlocks.totp` alone would seal a vault no passkey, PIN
   * or password can ever open (that is exactly how one got bricked). So the
   * ceremony is refused until a primary method exists.
   */
  async beginTotpEnrollment(): Promise<string> {
    const { header } = this.#requireUnlocked();
    if (this.#ephemeral || primaryUnlockCount(header) === 0) {
      throw new Error(
        "Seal this vault with a passkey, PIN or password before adding an authenticator code — a code can only guard a key.",
      );
    }
    const secret = randomTotpSecret();
    this.#pendingTotpSecret = secret;
    return totpSetupUri(secret, {
      label: "OpenSesame vault",
      issuer: "OpenSesame",
    });
  }

  /**
   * Prove the authenticator was set up, then turn the gate on. A wrong code
   * leaves everything as it was — this is enrollment, not an unlock, so it
   * counts toward no lockout.
   */
  async confirmTotpEnrollment(code: string): Promise<void> {
    const { vaultKey, header } = this.#requireUnlocked();
    const secret = this.#pendingTotpSecret;
    if (!secret) {
      throw new Error("Start authenticator enrollment first.");
    }
    if (this.#ephemeral || primaryUnlockCount(header) === 0) {
      this.#pendingTotpSecret = null;
      throw new Error(
        "Seal this vault with a passkey, PIN or password before adding an authenticator code — a code can only guard a key.",
      );
    }
    const ok = await totpCodeMatches(secret, code);
    if (!ok) {
      throw new WrongPasswordError(
        "That code did not match. Check the time on your authenticator and try again.",
      );
    }
    const gate = await sealTotpSecret(vaultKey, secret);
    const unlocks: VaultUnlocks = {
      ...header.unlocks,
      totp: gate,
    };
    await this.#persistHeader({ ...header, unlocks });
    this.#pendingTotpSecret = null;
  }

  /** Abandon an enrollment that never saw a matching code. */
  cancelTotpEnrollment(): void {
    this.#pendingTotpSecret = null;
  }

  async removeTotp(): Promise<void> {
    await this.#removeSecondStep("totp");
  }

  /**
   * Drop one second step. When it was the last, the recovery codes go with
   * it: they stand in for a second step, and there is none left to stand in
   * for.
   */
  async #removeSecondStep(step: "totp" | CodeChannel): Promise<void> {
    const header = this.#header;
    if (!header?.unlocks?.[step]) return;
    const { [step]: _removed, ...rest } = header.unlocks;
    const unlocks: VaultUnlocks = { ...rest };
    if (
      !hasSecondStep({ ...header, unlocks }) &&
      unlocks.recovery !== undefined
    ) {
      const { recovery: _codes, ...withoutCodes } = unlocks;
      await this.#persistHeader({
        ...header,
        unlocks: Object.keys(withoutCodes).length ? withoutCodes : undefined,
      });
      return;
    }
    await this.#persistHeader({
      ...header,
      unlocks: Object.keys(unlocks).length ? unlocks : undefined,
    });
  }

  /**
   * Start enrolling a code by email or text: the Identity API sends the
   * first code to the address; nothing is written until it matches. Same
   * rule as the authenticator — a code can only guard a key.
   */
  async beginCodeEnrollment(
    channel: CodeChannel,
    to: string,
  ): Promise<SentCode> {
    const { header } = this.#requireUnlocked();
    if (this.#ephemeral || primaryUnlockCount(header) === 0) {
      throw new Error(
        "Seal this vault with a passkey, PIN or password before adding a code by email or text — a code can only guard a key.",
      );
    }
    const sent = await sendCode(channel, to.trim());
    this.#pendingCode = sent;
    this.#pendingCodeAddress = { channel, to: to.trim() };
    return sent;
  }

  /** Prove the first code arrived, then seal the address and turn it on. */
  async confirmCodeEnrollment(code: string): Promise<void> {
    const { vaultKey, header } = this.#requireUnlocked();
    const sent = this.#pendingCode;
    const address = this.#pendingCodeAddress;
    if (!sent || !address) {
      throw new Error("Send a code first.");
    }
    if (this.#ephemeral || primaryUnlockCount(header) === 0) {
      this.cancelCodeEnrollment();
      throw new Error(
        "Seal this vault with a passkey, PIN or password before adding a code by email or text — a code can only guard a key.",
      );
    }
    await verifyCode(sent.challengeId, code);
    const toWrap = await sealText(vaultKey, address.to);
    const unlocks: VaultUnlocks = {
      ...header.unlocks,
      [address.channel]: { toWrap, since: new Date().toISOString() },
    };
    await this.#persistHeader({ ...header, unlocks });
    this.#pendingCode = null;
    this.#pendingCodeAddress = null;
  }

  /** Abandon a code enrollment whose first code never matched. */
  cancelCodeEnrollment(): void {
    this.#pendingCode = null;
    this.#pendingCodeAddress = null;
  }

  async removeCode(channel: CodeChannel): Promise<void> {
    await this.#removeSecondStep(channel);
  }

  /** The masked address a code channel sends to; needs the vault open. */
  async describeCodeChannel(channel: CodeChannel): Promise<string | null> {
    const { vaultKey, header } = this.#requireUnlocked();
    const record = header.unlocks?.[channel];
    if (!record) return null;
    const to = await openText(vaultKey, record.toWrap);
    if (channel === "email") {
      const at = to.indexOf("@");
      return `${to.slice(0, 1)}•••${to.slice(at)}`;
    }
    return `${to.slice(0, Math.max(2, to.length - 10))} ••• ••• ${to.slice(-4)}`;
  }

  /**
   * Make (or remake) the recovery codes. Sealed under the vault key, so
   * Settings can show the ones left while the vault is open; a new set
   * replaces the old one whole.
   */
  async generateRecoveryCodes(): Promise<string[]> {
    const { vaultKey, header } = this.#requireUnlocked();
    if (!hasSecondStep(header)) {
      throw new Error(
        "Recovery codes stand in for a second step. Add an authenticator, email or text code first.",
      );
    }
    const codes = randomRecoveryCodes(RECOVERY_CODE_COUNT);
    const ledger: RecoveryLedger = { codes, used: codes.map(() => false) };
    const codesWrap = await sealRecoveryLedger(vaultKey, ledger);
    await this.#persistHeader({
      ...header,
      unlocks: {
        ...header.unlocks,
        recovery: {
          codesWrap,
          total: codes.length,
          since: new Date().toISOString(),
        },
      },
    });
    return codes;
  }

  /** The recovery codes and which are spent, or null when none were made. */
  async recoveryCodes(): Promise<{
    codes: string[];
    used: boolean[];
    since: string;
  } | null> {
    const { vaultKey, header } = this.#requireUnlocked();
    const record = header.unlocks?.recovery;
    if (!record) return null;
    const ledger = await openRecoveryLedger(vaultKey, record);
    return { codes: ledger.codes, used: ledger.used, since: record.since };
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
    this.#pendingTotpSecret = null;
    this.#pendingCode = null;
    this.#pendingCodeAddress = null;
    this.#body = emptyBody();
    // A guest that ran beside a sealed vault did so in the isolated guest
    // tomb; locking it hands the screen back to the real vault.
    const guestBesideVault = this.#ephemeral && this.#scope.tomb === GUEST_TOMB;
    if (this.#ephemeral) {
      this.#header = null;
      this.#ephemeral = false;
    }
    // The tomb locks with the vault: sealed config (prefs, the IdP registry,
    // the projects view, the org profile) is unreadable until the next unlock.
    lockTomb(this.#scope.tomb);
    discardTombCaches();
    if (guestBesideVault) {
      this.#scope = scopedVaultScope();
      this.#header = this.#readHeader();
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
    // instead of leaving memory ahead of what survives a reload. The body
    // lands verbatim at the tomb path — content unchanged from what the
    // legacy flat key held.
    await writeSealedFile(this.#scope.tomb, BODY_PATH, sealed);
    this.#body.rev = rev;
    await this.#recordBodyRev(rev);
    // Recoverability (ADR 0039): sealed ciphertext must leave the device for
    // Host → outbox → GitHub. Local OPFS already succeeded; Host failure queues.
    const headerJson = readPlaintextFile(this.#scope.tomb, HEADER_PATH);
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
      if (merged.itemTypes !== undefined) body.itemTypes = merged.itemTypes;
    });
    // A type installed on another device arrives with this merge; rebuilding
    // the registry here is what makes it live without a re-unlock, which is
    // the whole of ADR 0087 §7's sync story.
    syncInstalledTypes(this.#body.itemTypes);
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
      await writePlaintextFile(
        this.#scope.tomb,
        HEADER_PATH,
        JSON.stringify(next),
      );
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
        ...(this.#body.itemTypes !== undefined
          ? { itemTypes: this.#body.itemTypes }
          : undefined),
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

  // —— item types (ADR 0087) ————————————————————————————————

  /**
   * Install an item type definition into this vault.
   *
   * The definition is validated first, so nothing invalid reaches the sealed
   * body; on success it is written there and syncs to the user's other
   * devices with everything else. No build, no reload.
   */
  async installItemTypeDefinition(text: string): Promise<InstallResult> {
    const result = installItemType(text);
    if (!result.ok) return result;
    try {
      await this.#mutate((body) => {
        body.itemTypes = installedDefinitions();
      });
    } catch (error) {
      // `#mutate` rolls the body back on a failed seal, but the registry is
      // module state it cannot reach. Put it back by hand, or this device
      // would offer a type the vault does not carry until the next unlock.
      syncInstalledTypes(this.#body.itemTypes);
      throw error;
    }
    return result;
  }

  /**
   * Remove an installed definition. Items of that type keep every value they
   * hold and render through the unknown-type fallback — coercing or dropping
   * them would destroy them on every other device, because the whole-vault
   * merge is last-writer-wins per item.
   */
  async uninstallItemTypeDefinition(id: string): Promise<boolean> {
    if (!uninstallItemType(id)) return false;
    try {
      await this.#mutate((body) => {
        body.itemTypes = installedDefinitions();
      });
    } catch (error) {
      syncInstalledTypes(this.#body.itemTypes);
      throw error;
    }
    return true;
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
    const body = readSealedFile(this.#scope.tomb, BODY_PATH);
    if (!body) throw new Error("There is nothing stored to export yet.");
    return JSON.stringify(
      {
        format: "opensesame-vault-export",
        v: 1,
        exportedAt: new Date().toISOString(),
        header: this.#header,
        body,
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
    // The export carried the definitions its items were written against.
    // Leaving them behind would import a pile of items nothing here can read.
    const incomingTypes = incoming.itemTypes ?? {};
    await this.#mutate((body) => {
      body.items = [...body.items, ...merged];
      body.folders = [...body.folders, ...mergedFolders];
      body.itemTypes = { ...incomingTypes, ...body.itemTypes };
    });
    syncInstalledTypes(this.#body.itemTypes);
    return merged.length;
  }

  /** Irreversibly remove the vault from this device. */
  async destroy(): Promise<void> {
    // The files to remove are the ones this session was using. Captured
    // before `lock()`, which hands a guest-beside-vault session back to the
    // real vault's scope: a guest deleting "this vault" deletes the guest
    // tomb, never the sealed vault it was running beside.
    const scope = this.#scope;
    // Deleting is at least as final as locking, so it runs the same teardown:
    // clipboard, Identity session, staged claims.
    this.lock();
    if (scope.tomb !== GUEST_TOMB) this.#header = null;
    this.#emit();
    // Queued behind any write still in the air. Deleting straight away would let
    // a persist that had already sealed its body land afterwards and put the
    // vault — ciphertext, header and all — back on a device it was deleted from.
    const done = this.#writeChain
      .catch(() => undefined)
      .then(async () => {
        // Awaited, so this resolves only once the files are actually gone.
        // The sealed area goes with the key: unreadable ciphertext that
        // would otherwise break a fresh vault in this tomb.
        await Promise.all([
          deletePlaintextFile(scope.tomb, HEADER_PATH),
          deleteFile(scope.tomb, BODY_PATH),
          kvDeleteDurable(scope.attempts),
          wipeTombOnDestroy(scope.tomb),
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
    this.#persistPrefs();
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
