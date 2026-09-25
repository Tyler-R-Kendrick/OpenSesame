import { isString, overlapCast } from "@opensesame/os-domain";
import {
  type Folder,
  type InstallResult,
  type SealedBlob,
  type VaultBody,
  VaultCorruptError,
  type VaultHeader,
  type VaultItem,
  WrongPasswordError,
  assertSealed,
  createVault,
  emptyBody,
  importVaultKey,
  installItemType,
  installedDefinitions,
  mergeVaultBodies,
  mintVaultKey,
  rewrapVaultKey,
  sameVaultContent,
  sealJson,
  syncInstalledTypes,
  uninstallItemType,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
  withTombstone,
  wrapVaultKeyWithPassword,
} from "@opensesame/vault-core";
import {
  activitySeams,
  noteVaultBodyPersisted,
  noteVaultUnlocked,
  recordActivityEvent,
} from "../activity-log.js";
import {
  decoyScratchScope,
  endEphemeralTomb,
  forgetDecoyScratch,
  guestTombIsSealed,
  isGuestSessionTomb,
  presentedTomb,
} from "../duress/store/decoy-scratch.js";
import { createDuressVaultActivationHost } from "../duress/store/vault-activation-host.js";
import { sessionRootDigestFromHeader } from "../duress/store/vault-session-digest.js";
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
  adoptMerged,
  recordItemTypes,
  renameFolder,
  restoreItem,
  toggleFavorite,
} from "./body-edits.js";
import { headerCarriesGate } from "./header-gate.js";
import { writeItem } from "./item-path.js";
import { emitVaultLock } from "./lock-events.js";
import {
  probePasskeyPrf,
  unlockVaultWithHeldPrf,
  unlockVaultWithPasskey,
} from "./passkey-unlock-session.js";
import {
  readPrefsJson,
  readPrefsSourceFile,
  writePrefsJson,
  writePrefsSourceFile,
} from "./prefs-io.js";
import {
  VAULT_PREFS_REVISION,
  type VaultPrefs,
  defaultPrefs,
  normalizeVaultPrefs,
} from "./prefs.js";
import { VaultProtectionBrowserService } from "./protection/browser-service.js";
import { ProtectionSessionGuard } from "./protection/session-guard.js";
import { spendRecoveryCode } from "./recovery-codes.js";
import { type SentCode, sendCode, verifyCode } from "./remote-code.js";
import { carryForkUnlockedIntoActiveScope } from "./scope-carry-fork.js";
import { carryOpenActiveScopeWithCurrentKey } from "./scope-carry-open.js";
import { openJsonForRebind, rebindTombSeals } from "./seal-rebind.js";
import {
  UnguardedTotpEnrollment,
  heldTotpCode,
  proveTotpEnrollment,
  startTotpEnrollment,
  withSelfAuthenticatorRegistration,
} from "./self-authenticator.js";
import { loadVaultBody } from "./store-body.js";
import {
  deviceHoldsSealedVault,
  readTombHeader,
  sharesWrapRecord,
} from "./store-header.js";
import {
  type DriveSnapshotInput,
  type SealedSnapshot,
  type SnapshotMerge,
  openSnapshotBody,
} from "./store-merge.js";
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
  createPasskeyUnlockCeremony,
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
  webauthnRpId,
  wrapVaultKeyWithPin,
  wrapVaultKeyWithPrf,
} from "./unlock-methods.js";
import { assertNewPassword, assertNewPin } from "./unlock-secret-guard.js";
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
    // Reload opens the last authorized account's unlock — guest included. Its
    // header is read like any tomb's; `headerCarriesGate` keeps a wrap-less
    // guest record from posing as a locked vault.
    this.#scope = lastVaultIsGuest() ? guestVaultScope() : scopedVaultScope();
    const header = this.#readHeader();
    this.#header =
      lastVaultIsGuest() && !headerCarriesGate(header) ? null : header;
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
    await carryForkUnlockedIntoActiveScope({
      vaultKey: this.#vaultKey,
      header: this.#header,
      ephemeral: this.#ephemeral,
      scope: this.#scope,
      sessionRootDigest: () => this.#sessionRootDigest(),
      assignScope: (next) => {
        this.#scope = next;
      },
      assignHeader: (next) => {
        this.#header = next;
      },
      assignBody: () => {
        this.#body = emptyBody();
      },
      clearPendingVaultKey: () => {
        this.#pendingVaultKey = null;
      },
      persistPrefs: () => this.#persistPrefs(),
      persist: () => this.#persist(),
      touch: () => this.touch(),
      armIdleTimer: () => this.#armIdleTimer(),
      emit: () => this.#emit(),
      nextScope: scopedVaultScope,
    });
  }

  /** The tomb this session is scoped to. */
  activeTomb(): string {
    return this.#scope.tomb;
  }

  /** Await in-flight body persists before duress activation or scope carries. */
  async flushPendingWrites(): Promise<void> {
    await this.#writeChain.catch(() => undefined);
  }

  #sessionRootDigest(): string | null {
    return sessionRootDigestFromHeader(
      this.#header,
      this.#vaultKey !== null,
      this.#ephemeral,
    );
  }

  /** Host surface for duress activation coordination (STORE-E). */
  duressActivationHost() {
    return createDuressVaultActivationHost({
      activeTomb: () => this.#scope.tomb,
      ephemeral: () => this.#ephemeral,
      header: () => this.#header,
      vaultKey: () => this.#vaultKey,
      flushPendingWrites: () => this.flushPendingWrites(),
      cancelPendingOps: () => this.#protection.cancelPendingOps(),
      sessionGeneration: () => this.#sessionGuard.generation,
    });
  }

  /** Equal wrap material means this session's key also opens `other`. False while locked. */
  sharesKeyWith(other: VaultHeader | null): boolean {
    if (!this.#vaultKey || !this.#header || !other) return false;
    if (this.#ephemeral) return false;
    return sharesWrapRecord(this.#header, other);
  }

  /** Open the active project when wraps match; lock the previous tomb first. */
  async openActiveScopeWithCurrentKey(): Promise<void> {
    await carryOpenActiveScopeWithCurrentKey({
      cancelPendingOps: () => this.#protection.cancelPendingOps(),
      vaultKey: this.#vaultKey,
      header: this.#header,
      ephemeral: this.#ephemeral,
      scope: this.#scope,
      body: this.#body,
      sessionRootDigest: () => this.#sessionRootDigest(),
      lockHandlers: [...this.#lockHandlers],
      activateSession: (key) => this.#activateSession(key),
      assignScope: (next) => {
        this.#scope = next;
      },
      assignHeader: (next) => {
        this.#header = next;
      },
      assignBody: (next) => {
        this.#body = next;
      },
      assignVaultKey: (key) => {
        this.#vaultKey = key;
      },
      emit: () => this.#emit(),
      nextScope: scopedVaultScope,
    });
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
      tomb: presentedTomb(this.#scope.tomb),
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
    await assertNewPassword(password);
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

  async createGuest(options?: {
    resume?: boolean;
    decoy?: boolean;
  }): Promise<void> {
    if (this.#vaultKey || this.#pendingVaultKey) {
      throw new Error("Lock the open vault before continuing as a guest.");
    }
    // Guests always run in GUEST_TOMB — physically separate from member tombs,
    // including first-run when no sealed vault exists yet. A duress decoy never
    // wipes a guest tomb that holds its own key: it runs in a scratch tomb.
    const scratch = options?.decoy === true && guestTombIsSealed();
    this.#scope = scratch ? decoyScratchScope() : guestVaultScope();
    // Fresh Continue-as-guest drops prior claims; unlock/resume keeps them
    // (GitHub App install return must not wipe the registrant).
    if (!options?.resume && !scratch) clearGuestConnections();
    forgetDecoyScratch(this.#scope.tomb);
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
    await assertNewPin(pin);
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
    return loadVaultBody(this.#scope.tomb, vaultKey, this.#header);
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

  async probePasskeyPrf(signal?: AbortSignal): Promise<ArrayBuffer> {
    return probePasskeyPrf(this.#passkeyUnlockHost(), signal);
  }

  async unlockWithHeldPrf(prfOutput: ArrayBuffer): Promise<void> {
    await unlockVaultWithHeldPrf(this.#passkeyUnlockHost(), prfOutput);
  }

  async unlockWithPasskey(signal?: AbortSignal): Promise<void> {
    await unlockVaultWithPasskey(this.#passkeyUnlockHost(), signal);
  }

  #passkeyUnlockHost() {
    return {
      header: () => this.#header,
      assertNotLockedOut: () => this.#assertNotLockedOut(),
      recordFailedUnlock: () => this.#recordFailedUnlock(),
      stashRaw: (raw: Uint8Array) => this.#stashRaw(raw),
      afterPrimaryUnwrap: (vaultKey: CryptoKey) =>
        this.#afterPrimaryUnwrap(vaultKey),
    };
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
    await assertNewPin(pin);
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
    await assertNewPassword(password);
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
    const guestBesideVault = isGuestSessionTomb(ephemeralTomb);
    const lockedTomb = this.#scope.tomb;
    if (this.#ephemeral) {
      this.#header = null;
      this.#ephemeral = false;
      forgetDecoyScratch(lockedTomb);
    }
    lockTomb(this.#scope.tomb);
    discardTombCaches();
    if (guestBesideVault) {
      if (recordLastVault) writeLastVaultId(GUEST_TOMB);
      this.#scope = guestVaultScope();
      // A decoy's scratch tomb hands back to the sealed guest it stood beside.
      this.#header = ephemeralTomb === GUEST_TOMB ? null : this.#readHeader();
    } else if (recordLastVault) {
      writeLastVaultId(lockedTomb);
    }
    if (ephemeralTomb) void endEphemeralTomb(ephemeralTomb);
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
    await assertNewPassword(next);
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

  /**
   * Merge another device's sealed snapshot of this vault (ADR 0144). Reports
   * whether this device changed and whether the snapshot is now behind it.
   */
  async mergeSnapshot(input: DriveSnapshotInput): Promise<SnapshotMerge> {
    const { vaultKey, header } = this.#requireUnlocked();
    await this.flushPendingWrites();
    const incoming = await openSnapshotBody(vaultKey, header, input);
    let merged = mergeVaultBodies(this.#body, incoming);
    const localChanged = !sameVaultContent(merged, this.#body);
    if (localChanged) {
      // Merged again inside the write chain, so an edit that landed meanwhile
      // is part of what gets sealed rather than overwritten by it.
      await this.#mutate((body) => {
        merged = mergeVaultBodies(body, incoming);
        adoptMerged(body, merged);
      });
      // A type installed on another device arrives with this merge; rebuilding
      // the registry here is what makes it live without a re-unlock (ADR 0087 §7).
      syncInstalledTypes(this.#body.itemTypes);
    }
    return { localChanged, remoteBehind: !sameVaultContent(merged, incoming) };
  }

  /** This vault's header and sealed body as stored, once pending writes land. */
  async sealedSnapshot(): Promise<SealedSnapshot> {
    const { header } = this.#requireUnlocked();
    await this.flushPendingWrites();
    const body = readSealedFile(this.#scope.tomb, BODY_PATH);
    if (!body) throw new Error("There is nothing stored to sync yet.");
    return { tomb: this.#scope.tomb, header, body, rev: this.#body.rev ?? 0 };
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
        tombstones: this.#body.tombstones,
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
    const added = [result.definition.metadata.id];
    try {
      await this.#mutate((body) => {
        recordItemTypes(body, installedDefinitions(), { added });
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
        recordItemTypes(body, installedDefinitions(), { removed: [id] });
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
    await this.#mutate((body) => restoreItem(body, id));
  }

  async purgeItem(id: string): Promise<void> {
    await this.#mutate((body) => {
      body.items = body.items.filter((item) => item.id !== id);
      body.tombstones = withTombstone(body.tombstones, "items", [id]);
    });
  }

  async emptyTrash(): Promise<void> {
    await this.#mutate((body) => {
      const gone = body.items.filter((item) => item.deletedAt !== null);
      body.items = body.items.filter((item) => item.deletedAt === null);
      body.tombstones = withTombstone(
        body.tombstones,
        "items",
        gone.map((item) => item.id),
      );
    });
  }

  async toggleFavorite(id: string): Promise<void> {
    await this.#mutate((body) => toggleFavorite(body, id));
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
    await this.#mutate((body) => renameFolder(body, id, name));
  }

  async deleteFolder(id: string): Promise<void> {
    await this.#mutate((body) => {
      body.folders = body.folders.filter((folder) => folder.id !== id);
      body.tombstones = withTombstone(body.tombstones, "folders", [id]);
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
      const added = Object.keys(incomingTypes).filter(
        (id) => body.itemTypes?.[id] === undefined,
      );
      recordItemTypes(body, { ...incomingTypes, ...body.itemTypes }, { added });
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
    if (isGuestSessionTomb(scope.tomb)) {
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

// A guest's tomb is sealed and isolated like any other, so a guest's
// actions are logged in it (PRODUCT.md: guests are first-class).
activitySeams.activeTomb = () => {
  const snap = vaultStore.getSnapshot();
  return snap.status === "unlocked" && snap.tomb ? snap.tomb : null;
};

export { WrongPasswordError, VaultCorruptError };
