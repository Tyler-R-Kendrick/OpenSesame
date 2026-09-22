import { isString, overlapCast } from "@opensesame/os-domain";
import {
  activitySeams,
  noteVaultBodyPersisted,
  noteVaultUnlocked,
  recordActivityEvent,
} from "../activity-log.js";
import { clearGuestConnections } from "../guest-connections.js";
/** Vault session store: unlocked body in memory, sealed to OPFS, key dropped on lock (ADR 0063). */
import {
  kvDelete,
  kvDeleteDurable,
  kvDurability,
  kvGet,
  kvSet,
} from "../kv.js";
import { lastVaultIsGuest, writeLastVaultId } from "../last-vault.js";
import {
  activeProject,
  carryProjectsViewInto,
  projectsState,
  scopedKey,
} from "../projects.js";
import {
  BODY_PATH,
  GUEST_TOMB,
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
  vaultSealBinding,
  wrapVaultKeyWithPassword,
} from "./crypto.js";
import { writeItem } from "./item-path.js";
import {
  type InstallResult,
  installItemType,
  installedDefinitions,
  syncInstalledTypes,
  uninstallItemType,
} from "./item-types.js";
import { emitVaultLock } from "./lock-events.js";
import {
  type Folder,
  type VaultBody,
  type VaultItem,
  emptyBody,
  mergeVaultBodies,
} from "./model.js";
import {
  readPrefsJson,
  readPrefsSourceFile,
  writePrefsJson,
  writePrefsSourceFile,
} from "./prefs-io.js";
import {
  VAULT_PREFS_REVISION,
  type VaultPrefs,
  assertMasterPasswordPolicy,
  defaultPrefs,
  normalizeVaultPrefs,
} from "./prefs.js";
import { VaultProtectionBrowserService } from "./protection/browser-service.js";
import { ProtectionSessionGuard } from "./protection/session-guard.js";
import { spendRecoveryCode } from "./recovery-codes.js";
import { type SentCode, sendCode, verifyCode } from "./remote-code.js";
import { openJsonForRebind, rebindTombSeals } from "./seal-rebind.js";
import {
  UnguardedTotpEnrollment,
  heldTotpCode,
  proveTotpEnrollment,
  startTotpEnrollment,
  withSelfAuthenticatorRegistration,
} from "./self-authenticator.js";
import {
  deviceHoldsSealedVault,
  readTombHeader,
  sharesWrapRecord,
} from "./store-header.js";
import {
  discardTombCaches,
  hydrateAndMigrateTombOnUnlock,
  wipeTombOnDestroy,
} from "./tomb-migration.js";
import {
  type CodeChannel,
  RECOVERY_CODE_COUNT,
  type RecoveryLedger,
  type TotpGateRecord,
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
  sealRecoveryLedger,
  sealText,
  totpCodeMatches,
  unwrapVaultKeyWithPin,
  unwrapVaultKeyWithPrf,
  webauthnRpId,
  wrapVaultKeyWithPin,
  wrapVaultKeyWithPrf,
} from "./unlock-methods.js";
export { deviceHoldsSealedVault, readTombHeader, sharesWrapRecord };
export { PREFS_CONFIG_PATH, PREFS_SOURCE_CONFIG_PATH } from "./prefs-io.js";

/** Guest-beside-vault tomb — isolated, throwaway, never a project id. */
export { GUEST_TOMB };
import {
  ATTEMPTS_KEY,
  BASE_LOCKOUT_MS,
  LOCK_AFTER_FAILS,
  MAX_LOCKOUT_MS,
  type VaultScope,
  guestVaultScope,
  readJson,
  scopedVaultScope,
} from "./store-scope.js";
export { ATTEMPTS_KEY };
export {
  type VaultPrefs,
  VAULT_PREFS_REVISION,
  assertMasterPasswordPolicy,
  defaultPrefs,
  normalizeVaultPrefs,
} from "./prefs.js";

export type VaultStatus = "empty" | "locked" | "unlocked";

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
  /** Primary unlocked; second step enrolled but not yet confirmed. */
  awaitingSecondStep: boolean;
  /** False when storage is tab-only (no durable OPFS). */
  durable: boolean;
};

type Listener = () => void;

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
  /** Guest/this-tab: key never wrapped; lock must not leave a wrap-less header. */
  #ephemeral = false;
  #sessionGuard = new ProtectionSessionGuard();
  #protection: VaultProtectionBrowserService;

  constructor() {
    this.#header = this.#readHeader();
    this.#protection = new VaultProtectionBrowserService({
      isGuestOrEphemeral: () =>
        this.#ephemeral || this.#scope.tomb === GUEST_TOMB,
      getHeader: () => this.#header,
      requireRawRoot: () => this.#requireRaw(),
      isUnlocked: () => this.#vaultKey !== null && this.#header !== null,
      persistHeader: (next) => this.#persistHeader(next),
      replaceRawVaultKey: (next) => this.#replaceRawVaultKey(next),
      session: this.#sessionGuard,
    });
    this.#snapshot = this.#build();
  }

  /** Root-protection lifecycle for the active vault session. */
  get protection(): VaultProtectionBrowserService {
    return this.#protection;
  }

  /** Re-read plaintext state after OPFS hydration fills the KV cache. */
  rehydrate(): void {
    if (this.#vaultKey || this.#pendingVaultKey) return;
    // Reload opens the last authorized account's unlock — guest included.
    if (lastVaultIsGuest()) {
      this.#scope = guestVaultScope();
      this.#header = null;
    } else {
      this.#scope = scopedVaultScope();
      this.#header = this.#readHeader();
    }
    this.#emit();
  }

  /** Drop the previous project session and read the active project's header. */
  loadActiveProjectScope(): void {
    // Explicit project swap — do not let lock()'s guest keep overwrite the
    // destination tomb as last-vault, then write the project tomb below.
    this.lock({ recordLastVault: false });
    this.#scope = scopedVaultScope();
    this.#header = this.#readHeader();
    writeLastVaultId(this.#scope.tomb);
    this.#emit();
  }

  /** Carry this unlock into the active project (shared device key). */
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

  /** Equal wrap material means this session's key also opens `other`. False while locked. */
  sharesKeyWith(other: VaultHeader | null): boolean {
    if (!this.#vaultKey || !this.#header || !other) return false;
    if (this.#ephemeral) return false;
    return sharesWrapRecord(this.#header, other);
  }

  /** Open the active project when wraps match; lock the previous tomb first. */
  async openActiveScopeWithCurrentKey(): Promise<void> {
    this.#protection.cancelPendingOps();
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
    emitVaultLock();
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

  #persistPrefs(): void {
    if (!this.#vaultKey) return;
    void writePrefsJson(this.#scope.tomb, this.#prefs).catch(() => undefined);
  }

  async #loadPrefsFromVfs(): Promise<void> {
    try {
      const stored: Partial<VaultPrefs> = overlapCast(
        await readPrefsJson(this.#scope.tomb),
      );
      this.#prefs = normalizeVaultPrefs(stored);
      if ((stored.prefsRevision ?? 0) < VAULT_PREFS_REVISION) {
        await writePrefsJson(this.#scope.tomb, this.#prefs).catch(
          () => undefined,
        );
      }
    } catch (error) {
      if (error instanceof VfsError && error.code === "locked") throw error;
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

  /** Root-rotate: swap the in-memory VK and re-seal the body under it. */
  async #replaceRawVaultKey(next: Uint8Array): Promise<void> {
    if (!this.#vaultKey || !this.#header) {
      throw new Error("Unlock the vault before rotating the vault key.");
    }
    const vaultKey = await importVaultKey(next);
    this.#stashRaw(next);
    this.#vaultKey = vaultKey;
    await this.#persist();
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

  /** Guest sessions use `GUEST_TOMB` only. `lock()` keeps the unlock screen on guest when that was the last account. */
  /**
   * Point the unlock screen at the guest tomb without opening a session.
   * Guests have no passkey or password — Unlock is the only challenge.
   */
  prepareGuestUnlock(): void {
    if (this.#vaultKey || this.#pendingVaultKey) {
      this.lock();
    } else {
      this.#protection.cancelPendingOps();
    }
    this.#scope = guestVaultScope();
    this.#header = null;
    this.#vaultKey = null;
    this.#pendingVaultKey = null;
    this.#ephemeral = false;
    this.#body = emptyBody();
    writeLastVaultId(GUEST_TOMB);
    this.#emit();
  }

  async createGuest(options?: { resume?: boolean }): Promise<void> {
    if (this.#vaultKey || this.#pendingVaultKey) {
      throw new Error("Lock the open vault before continuing as a guest.");
    }
    // Guests always run in GUEST_TOMB — physically separate from member tombs,
    // including first-run when no sealed vault exists yet.
    this.#scope = guestVaultScope();
    // Fresh Continue-as-guest drops prior claims; unlock/resume keeps them
    // (GitHub App install return must not wipe the registrant).
    if (!options?.resume) clearGuestConnections();
    // Whatever a previous guest left behind is ciphertext under a key that
    // died with its tab — unreadable, and in the way of a fresh session.
    lockTomb(this.#scope.tomb);
    await wipeTombOnDestroy(this.#scope.tomb);
    await deleteFile(this.#scope.tomb, BODY_PATH);
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
    writeLastVaultId(GUEST_TOMB);
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
    writeLastVaultId(this.#scope.tomb);
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
    const binding = vaultSealBinding(this.#scope.tomb, BODY_PATH);
    try {
      const body = await openJson<VaultBody>(vaultKey, sealed, binding);
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
      await rebindTombSeals(this.#scope.tomb, vaultKey);
      // Phase C: seal any legacy plaintext config into this tomb and hydrate
      // every module's view of it, then this session's prefs and body.
      await hydrateAndMigrateTombOnUnlock(this.#scope.tomb);
      await this.#loadPrefsFromVfs();
      this.#body = await this.#loadBody(vaultKey);
      syncInstalledTypes(this.#body.itemTypes);
    } catch (error) {
      this.#vaultKey = null;
      lockTomb(this.#scope.tomb);
      this.#zeroRaw();
      this.#body = emptyBody();
      throw error;
    }
    await this.#protection.ensureProtectionProjected();
    kvDelete(this.#scope.attempts);
    writeLastVaultId(this.#scope.tomb);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
    noteVaultUnlocked();
  }
  /** After primary unwrap: either activate or park the key for a second step. */
  async #afterPrimaryUnwrap(vaultKey: CryptoKey): Promise<void> {
    if (hasSecondStep(this.#header)) {
      this.#pendingVaultKey = vaultKey;
      const gate = this.#header?.unlocks?.totp;
      // The vault is its own registered authenticator: supply the code from
      // the sealed seed instead of asking (ADR 0113); on anything unusual,
      // fall back to asking.
      if (gate?.selfItemId) {
        const code = await heldTotpCode(gate, await this.#loadBody(vaultKey));
        if (code !== null) {
          try {
            await this.confirmTotp(code);
            return;
          } catch {
            // A code that fails anyway (skewed clock) falls back to asking.
          }
        }
      }
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
    // A gate with no registration yet gets one now (ADR 0113).
    if (!gate.selfItemId) await this.#registerSelfAuthenticator(gate);
  }

  cancelTotpChallenge(): void {
    this.#pendingVaultKey = null;
    this.#pendingCode = null;
    this.#emit();
  }

  /** Step 2 by email/text: send a code to the sealed address. */
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

  /** Spend a recovery code as the second step (see `recovery-codes.ts`). */
  async redeemRecoveryCode(code: string): Promise<void> {
    this.#assertNotLockedOut();
    const pending = this.#pendingVaultKey;
    const header = this.#header;
    const record = header?.unlocks?.recovery;
    if (!pending || !header || !record) {
      throw new WrongPasswordError("That recovery code is not valid.");
    }
    const codesWrap = await spendRecoveryCode(pending, record, code, () =>
      this.#recordFailedUnlock(),
    );
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
   * Start enrolling an authenticator code as the second step. Returns an
   * otpauth URI; the gate is written only once a code matches.
   */
  async beginTotpEnrollment(): Promise<string> {
    const { header } = this.#requireUnlocked();
    const started = startTotpEnrollment(
      this.#ephemeral,
      primaryUnlockCount(header),
    );
    this.#pendingTotpSecret = started.secret;
    return started.uri;
  }

  /**
   * Prove the authenticator was set up, turn the gate on, and register the
   * vault as its own authenticator (ADR 0113).
   */
  async confirmTotpEnrollment(code: string): Promise<void> {
    const { vaultKey, header } = this.#requireUnlocked();
    try {
      const gate = await proveTotpEnrollment({
        ephemeral: this.#ephemeral,
        primaryCount: primaryUnlockCount(header),
        secret: this.#pendingTotpSecret,
        code,
        vaultKey,
      });
      await this.#persistHeader({
        ...header,
        unlocks: { ...header.unlocks, totp: gate },
      });
      await this.#registerSelfAuthenticator(gate);
    } catch (error) {
      if (error instanceof UnguardedTotpEnrollment) {
        this.#pendingTotpSecret = null;
      }
      throw error;
    }
    this.#pendingTotpSecret = null;
  }

  /** Abandon an enrollment that never saw a matching code. */
  cancelTotpEnrollment(): void {
    this.#pendingTotpSecret = null;
  }

  /** Point a gate at its self-authenticator registration (ADR 0113). */
  async #registerSelfAuthenticator(gate: TotpGateRecord): Promise<void> {
    if (!this.#header || !this.#vaultKey) return;
    const next = await withSelfAuthenticatorRegistration(
      this.#vaultKey,
      gate,
      this.#header,
      this.#body,
    );
    if (next.item) await this.saveItem(next.item);
    await this.#persistHeader(next.header);
  }

  async removeTotp(): Promise<void> {
    await this.#removeSecondStep("totp");
  }

  /** Drop one second step; the last one takes the recovery codes with it. */
  async #removeSecondStep(step: "totp" | CodeChannel): Promise<void> {
    const header = this.#header;
    if (!header?.unlocks?.[step]) return;
    // The authenticator's registration goes with its gate.
    if (step === "totp") {
      const selfId = header.unlocks.totp?.selfItemId;
      if (selfId) await this.trashItem(selfId);
    }
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

  /** Enroll email/text code; nothing is written until a code matches. */
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

  lock = (options?: { recordLastVault?: boolean }): void => {
    this.#protection.cancelPendingOps();
    const recordLastVault = options?.recordLastVault !== false;
    const wasUnlocked = this.#vaultKey !== null;
    const lockedTombForLog = this.#scope.tomb;
    const wasGuest = this.#ephemeral;
    this.#vaultKey = null;
    this.#zeroRaw();
    this.#pendingVaultKey = null;
    this.#pendingTotpSecret = null;
    this.#pendingCode = null;
    this.#pendingCodeAddress = null;
    this.#body = emptyBody();
    syncInstalledTypes(undefined);
    // Guest sessions are ephemeral — wipe ciphertext, but keep the unlock
    // screen on guest when that was the last authorized account.
    const ephemeralTomb = this.#ephemeral ? this.#scope.tomb : null;
    const guestBesideVault = ephemeralTomb === GUEST_TOMB;
    const lockedTomb = this.#scope.tomb;
    if (this.#ephemeral) {
      this.#header = null;
      this.#ephemeral = false;
    }
    lockTomb(this.#scope.tomb);
    discardTombCaches();
    if (guestBesideVault) {
      if (recordLastVault) writeLastVaultId(GUEST_TOMB);
      this.#scope = guestVaultScope();
      this.#header = null;
    } else if (recordLastVault) {
      writeLastVaultId(lockedTomb);
    }
    if (ephemeralTomb) void wipeTombOnDestroy(ephemeralTomb);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    for (const handler of this.#lockHandlers) handler();
    emitVaultLock();
    if (wasUnlocked && !wasGuest) {
      void recordActivityEvent(lockedTombForLog, {
        category: "vault",
        type: "vault.locked",
        summary: "Vault locked",
        outcome: "succeeded",
      }).catch(() => undefined);
    }
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
    // Revision advances only after the sealed write lands.
    const rev = (this.#body.rev ?? 0) + 1;
    const sealed = await sealJson(
      this.#vaultKey,
      { ...this.#body, rev },
      vaultSealBinding(this.#scope.tomb, BODY_PATH),
    );
    assertSealed(sealed);
    await writeSealedFile(this.#scope.tomb, BODY_PATH, sealed);
    this.#body.rev = rev;
    await this.#recordBodyRev(rev);
    noteVaultBodyPersisted();
  }

  /** Merge a complete newer snapshot while both bodies are authenticated. */
  async mergeSnapshot(input: {
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
      throw new VaultCorruptError("Vault snapshot is not valid JSON");
    }
    if (
      remoteHeader.v !== 1 ||
      remoteHeader.createdAt !== header.createdAt ||
      !sealed.ivB64 ||
      !sealed.ctB64
    ) {
      throw new VaultCorruptError("Vault snapshot belongs to another vault");
    }
    const opened = await openJsonForRebind<VaultBody>(
      vaultKey,
      sealed,
      vaultSealBinding(this.#scope.tomb, BODY_PATH),
    );
    const incoming = opened.value;
    if (
      incoming.v !== 1 ||
      !Array.isArray(incoming.items) ||
      !Array.isArray(incoming.folders)
    ) {
      throw new VaultCorruptError("Vault body is malformed");
    }
    if ((incoming.rev ?? 0) !== input.epoch) {
      throw new VaultCorruptError("Vault epoch does not match its body");
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

  /** Validate a definition, store it in the sealed body, and register it for this session. */
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

  /** Drop a definition. Items of that type keep their values. */
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

  async saveItem(item: VaultItem, folder?: Folder): Promise<void> {
    await this.#mutate((body) => {
      writeItem(body, item, folder);
    });
  }

  /**
   * Write several items as one change: one seal, one file write, and one
   * link in the write chain. An import must land whole or not at all — a
   * loop of `saveItem` leaves half an import behind when the quota runs
   * out, the write fails, or the tab loses its handle (ADR 0130, SB-069).
   */
  async saveItems(items: readonly VaultItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.#mutate((body) => {
      for (const item of items) writeItem(body, item);
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
        tomb: this.#scope.tomb,
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
      tomb?: string;
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
    const named = parsed.tomb ?? "";
    const tomb = isString(named) && named.length > 0 ? named : this.#scope.tomb;
    const opened = await openJsonForRebind<VaultBody>(
      key,
      parsed.body,
      vaultSealBinding(tomb, BODY_PATH),
    );
    const incoming = opened.value;

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
    // before `lock()`: a guest deleting "this vault" deletes the guest tomb,
    // never the sealed vault it was running beside. After wipe, hand the
    // unlock screen back to the personal vault — destroy leaves guest, it
    // does not lock guest for re-entry.
    const scope = this.#scope;
    // Deleting is at least as final as locking, so it runs the same teardown:
    // clipboard, Identity session, staged claims.
    this.lock();
    if (scope.tomb === GUEST_TOMB) {
      this.#scope = scopedVaultScope();
      this.#header = this.#readHeader();
      writeLastVaultId(this.#scope.tomb);
    } else {
      this.#header = null;
    }
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

  async commitPrefs(next: Partial<VaultPrefs>): Promise<void> {
    if (!this.#vaultKey)
      throw new Error("Unlock the vault before saving preferences.");
    this.setPrefs(next);
    await writePrefsJson(this.#scope.tomb, this.#prefs);
  }

  async writePrefsSource(source: string): Promise<void> {
    if (!this.#vaultKey)
      throw new Error("Unlock the vault before saving preferences.");
    await writePrefsSourceFile(this.#scope.tomb, source);
  }

  async readPrefsSource(): Promise<string | null> {
    return this.#vaultKey ? readPrefsSourceFile(this.#scope.tomb) : null;
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

activitySeams.activeTomb = () => {
  const snap = vaultStore.getSnapshot();
  return snap.status === "unlocked" && !snap.guest && snap.tomb
    ? snap.tomb
    : null;
};

export { WrongPasswordError, VaultCorruptError };
