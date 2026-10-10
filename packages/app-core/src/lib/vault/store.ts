import { overlapCast } from "@opensesame/os-domain";
import {
  type Folder,
  type InstallResult,
  type VaultBody,
  VaultCorruptError,
  type VaultHeader,
  type VaultItem,
  WrongPasswordError,
  createVault,
  emptyBody,
  importVaultKey,
  installItemType,
  installedDefinitions,
  mintVaultKey,
  resolveAccounts,
  syncInstalledTypes,
  uninstallItemType,
} from "@opensesame/vault-core";
import {
  activitySeams,
  noteVaultBodyPersisted,
  noteVaultUnlocked,
  recordActivityEvent,
} from "../activity-log.js";
import { refuseWhileFrozen } from "../duress/hold/gate.js";
import {
  decoyScratchScope,
  endEphemeralTomb,
  forgetDecoyScratch,
  guestTombIsSealed,
  isDecoySession,
  isGuestSessionTomb,
  markDecoySession,
  presentedTomb,
} from "../duress/store/decoy-scratch.js";
import { createDuressVaultActivationHost } from "../duress/store/vault-activation-host.js";
import { sessionRootDigestFromKey } from "../duress/store/vault-session-digest.js";
import { clearGuestConnections } from "../guest-connections.js";
/** Vault session store: unlocked body in memory, sealed to OPFS, key dropped on lock (ADR 0063). */
import { kvDelete, kvDeleteDurable, kvDurability } from "../kv.js";
import { lastVaultIsGuest, writeLastVaultId } from "../last-vault.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  VfsError,
  deleteFile,
  deletePlaintextFile,
  lockTomb,
  readSealedFile,
  unlockTomb,
  writePlaintextFile,
} from "../vfs.js";
import {
  appendItems,
  applyManifestPlan,
  bodyBeforeWrite,
  deleteFolder,
  recordItemTypes,
  renameFolder,
  replaceItems,
  restoreItem,
  stampedEdit,
  toggleFavorite,
} from "./body-edits.js";
import { commitDiscard, revokeTrashedShares } from "./drop-revoke.js";
import { headerCarriesGate } from "./header-gate.js";
import {
  type ItemReturn,
  type ItemWithdrawal,
  restoreIntoBody,
  withdrawFromBody,
} from "./item-departure.js";
import { type ItemWriteHost, writeSavedItems } from "./item-writes.js";
import { emitVaultLock } from "./lock-events.js";
import {
  adoptedMasterWrap,
  headerWithNewPassword,
  headerWithPassword,
  headerWithoutPassword,
  noteMasterWrap,
  wrapMoved,
} from "./master-wrap.js";
import {
  probePasskeyCeremony,
  sealNewVaultWithPasskey,
  unlockVaultWithHeldPrf,
  unlockVaultWithPasskey,
  wrapVaultKeyWithCeremony,
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
import type { PasskeyCreateOptions } from "./protection/adapters/webauthn-prf-ceremony.js";
import { VaultProtectionBrowserService } from "./protection/browser-service.js";
import { ProtectionSessionGuard } from "./protection/session-guard.js";
import {
  type ProtectorUnlockInput,
  probeProtectorRoot,
  unlockVaultWithHeldRoot,
  unlockVaultWithProtector,
} from "./protector-unlock-session.js";
import {
  maskCodeAddress,
  mintRecoveryCodes,
  readRecoveryCodes,
  spendRecoveryCode,
} from "./recovery-codes.js";
import { type SentCode, sendCode, verifyCode } from "./remote-code.js";
import { carryForkUnlockedIntoActiveScope } from "./scope-carry-fork.js";
import { carryOpenActiveScopeWithCurrentKey } from "./scope-carry-open.js";
import { rebindTombSeals, rekeyTomb } from "./seal-rebind.js";
import { CodeSendGuard, PendingChallenge } from "./second-step-guard.js";
import {
  UnguardedTotpEnrollment,
  heldTotpCode,
  proveTotpEnrollment,
  startTotpEnrollment,
  withSelfAuthenticatorRegistration,
} from "./self-authenticator.js";
import { loadVaultBody } from "./store-body.js";
import {
  type ApplyChange,
  type VaultBodyPort,
  bodyPortOf,
  installDeviceKeyCarrier,
  levelDeviceKey,
  makeBodyPort,
  registerBodyPort,
} from "./store-device-key.js";
import { freshBody, sealMark } from "./store-fresh.js";
import {
  deviceHoldsSealedVault,
  readTombHeader,
  sharesWrapRecord,
} from "./store-header.js";
import {
  type ImportOptions,
  importSealedInto,
  sealedVaultExport,
} from "./store-import.js";
import {
  type DriveSnapshotInput,
  type SealedSnapshot,
  type SnapshotMerge,
  mergeSnapshotInto,
} from "./store-merge.js";
import { writeBody } from "./store-seal.js";
import {
  discardTombCaches,
  discardVaultBody,
  hydrateAndMigrateTombOnUnlock,
  wipeTombOnDestroy,
} from "./tomb-migration.js";
import {
  type CodeChannel,
  type TotpGateRecord,
  type VaultUnlocks,
  assertKeepsPrimaryUnlock,
  createPasskeyUnlockCeremony,
  hasSecondStep,
  openText,
  openTotpSecret,
  primaryUnlockCount,
  sealText,
  totpCodeMatches,
  wrapVaultKeyWithPin,
} from "./unlock-methods.js";
import { assertNewPassword, assertNewPin } from "./unlock-secret-guard.js";
import {
  withBodyWriteLock,
  withBodyWriteLockOrBare,
  withExclusiveOpenLease,
} from "./vault-shared-locks.js";
export { deviceHoldsSealedVault, readTombHeader, sharesWrapRecord };
export { PREFS_CONFIG_PATH, PREFS_SOURCE_CONFIG_PATH } from "./prefs-io.js";

/** Guest-beside-vault tomb — isolated, throwaway, never a project id. */
export { GUEST_TOMB };
import { PIN_MISS, unwrapPassword, unwrapPin } from "./primary-unwrap.js";
import {
  ATTEMPTS_KEY,
  type VaultScope,
  guestVaultScope,
  scopedVaultScope,
} from "./store-scope.js";
import {
  assertNotLockedOut,
  readAttempts,
  recordFailedUnlock,
} from "./unlock-attempts.js";
export { ATTEMPTS_KEY };
export {
  type VaultPrefs,
  VAULT_PREFS_REVISION,
  assertMasterPasswordPolicy,
  defaultPrefs,
  normalizeVaultPrefs,
} from "./prefs.js";

import { type VaultState, bindGuestSessionStore } from "./store-state.js";
export type { VaultState, VaultStatus } from "./store-state.js";

type Listener = () => void;

export class VaultStore {
  #vaultKey: CryptoKey | null = null;
  /** Raw VK for enroll-only wrapKey substitutes; wiped on lock and cancel. */
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
  /** Expiry for a parked second step; cleared when the challenge ends. */
  #pendingChallenge = new PendingChallenge();
  /** Per-challenge throttle for email/text code sends. */
  #sendGuard = new CodeSendGuard();
  /** Serializes body writes so overlapping mutations cannot land out of order. */
  #writeChain: Promise<unknown> = Promise.resolve();
  /** The seal of the body this tab last wrote or read; another writer's differs. */
  #sealMark: string | null = null;
  #lockHandlers = new Set<() => void>();
  #scope: VaultScope = scopedVaultScope();
  /** Guest/this-tab: key never wrapped; lock must not leave a wrap-less header. */
  #ephemeral = false;
  #sessionGuard = new ProtectionSessionGuard();
  #protection: VaultProtectionBrowserService;

  constructor() {
    this.#header = this.#readHeader();
    registerBodyPort(this, () => this.#bodyPort());
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
    // Explicit project swap — lock() must not keep the destination tomb as last-vault.
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

  #sessionRootDigest(): Promise<string | null> {
    return sessionRootDigestFromKey(this.#vaultKey, this.#ephemeral);
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

  #readAttempts() {
    return readAttempts(this.#scope.attempts);
  }

  #persistPrefs(): void {
    if (!this.#vaultKey) return;
    const { tomb } = this.#scope;
    const prefs = this.#prefs;
    this.#writeChain = this.#writeChain.then(() =>
      writePrefsJson(tomb, prefs).catch(() => this.#restorePrefs(prefs)),
    );
  }

  async #restorePrefs(prefs: VaultPrefs): Promise<void> {
    if (this.#prefs !== prefs) return;
    const durable: Partial<VaultPrefs> = overlapCast(
      await readPrefsJson(this.#scope.tomb).catch(() => ({})),
    );
    this.#prefs = normalizeVaultPrefs(durable);
    this.#armIdleTimer();
    this.#emit();
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
    const attempts = this.#readAttempts();
    return {
      status: this.#vaultKey ? "unlocked" : this.#header ? "locked" : "empty",
      tomb: presentedTomb(this.#scope.tomb),
      guest: this.#ephemeral && this.#vaultKey !== null,
      decoy: this.#ephemeral && this.#vaultKey !== null && isDecoySession(),
      header: this.#header,
      items: resolveAccounts(this.#body.items),
      rawItems: this.#body.items,
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

  /** Root-rotate: re-seal the tomb's files and the body under the new VK. */
  async #replaceRawVaultKey(next: Uint8Array): Promise<void> {
    if (!this.#vaultKey || !this.#header) {
      throw new Error("Unlock the vault before rotating the vault key.");
    }
    const vaultKey = await rekeyTomb(this.#scope.tomb, this.#vaultKey, next);
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
  async createWithPasskey(
    signal?: AbortSignal,
    options?: PasskeyCreateOptions,
  ): Promise<void> {
    await sealNewVaultWithPasskey(
      (header, key, raw) => this.#persistNewVault(header, key, raw),
      signal,
      options,
    );
  }

  /**
   * Point the unlock screen at the guest tomb without opening a session.
   * Guests have no passkey or password — Unlock is the only challenge.
   * Guest sessions use `GUEST_TOMB` only; `lock()` keeps the last guest.
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
    // Guests run in GUEST_TOMB, apart from member tombs; a decoy never wipes a
    // guest tomb that holds its own key: it runs in a scratch tomb.
    markDecoySession(options?.decoy === true);
    const scratch = options?.decoy === true && guestTombIsSealed();
    this.#scope = scratch ? decoyScratchScope() : guestVaultScope();
    // Fresh Continue-as-guest drops prior claims; unlock/resume keeps them (GitHub App return).
    if (!options?.resume && !scratch) clearGuestConnections();
    forgetDecoyScratch(this.#scope.tomb);
    // A previous guest's leftovers are ciphertext under a dead tab's key — unreadable, in the way.
    lockTomb(this.#scope.tomb);
    await wipeTombOnDestroy(this.#scope.tomb);
    await discardVaultBody(this.#scope.tomb);
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
    // A decoy leaves the unlock screen on the vault it was typed at.
    if (!options?.decoy) writeLastVaultId(GUEST_TOMB);
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
    assertNotLockedOut(this.#scope.attempts);
  }

  #recordFailedUnlock(): void {
    recordFailedUnlock(this.#scope.attempts);
    this.#emit();
  }

  /**
   * A held device (a freeze duress code, ADR 0168) refuses a right credential
   * as a wrong one: same error, same count; the key it opened is zeroed.
   */
  #refuseWhileFrozen(miss?: string): void {
    refuseWhileFrozen(
      this.#scope.tomb,
      () => {
        this.#recordFailedUnlock();
        if (!this.#vaultKey) this.cancelTotpChallenge();
      },
      miss,
    );
  }

  async #loadBody(vaultKey: CryptoKey): Promise<VaultBody> {
    return loadVaultBody(this.#scope.tomb, vaultKey, this.#header);
  }

  async #activateSession(vaultKey: CryptoKey): Promise<void> {
    this.#refuseWhileFrozen();
    this.#vaultKey = vaultKey;
    this.#pendingVaultKey = null;
    this.#pendingChallenge.clear();
    unlockTomb(this.#scope.tomb, vaultKey);
    try {
      await rebindTombSeals(this.#scope.tomb, vaultKey);
      // Phase C: seal legacy plaintext config into this tomb, hydrate modules, then prefs and body.
      await hydrateAndMigrateTombOnUnlock(this.#scope.tomb);
      await this.#loadPrefsFromVfs();
      this.#body = await this.#loadBody(vaultKey);
      this.#sealMark = sealMark(this.#scope.tomb);
      syncInstalledTypes(this.#body.itemTypes);
    } catch (error) {
      this.#vaultKey = null;
      lockTomb(this.#scope.tomb);
      this.#zeroRaw();
      this.#body = emptyBody();
      throw error;
    }
    await levelDeviceKey(this.#bodyPort());
    await this.#protection.ensureProtectionProjected();
    kvDelete(this.#scope.attempts);
    writeLastVaultId(this.#scope.tomb);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
    noteVaultUnlocked();
  }
  /** After primary unwrap: either activate or park the key for a second step. */
  async #afterPrimaryUnwrap(vaultKey: CryptoKey, miss?: string) {
    this.#refuseWhileFrozen(miss);
    if (hasSecondStep(this.#header)) {
      this.#pendingVaultKey = vaultKey;
      const gate = this.#header?.unlocks?.totp;
      // The vault is its own registered authenticator: supply the code from
      // the sealed seed instead of asking (ADR 0113); failure falls back.
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
      this.#sendGuard.reset();
      this.#pendingChallenge.arm(() => {
        if (this.#pendingVaultKey === vaultKey) this.cancelTotpChallenge();
      });
      this.#emit();
      return;
    }
    await this.#activateSession(vaultKey);
  }

  async unlock(password: string): Promise<void> {
    this.#assertNotLockedOut();
    if (!this.#header) throw new Error("There is no vault on this device yet.");
    const record = () => this.#recordFailedUnlock();
    await this.#openWithRaw(
      await unwrapPassword(this.#header, password, record),
    );
  }

  async unlockWithPin(pin: string): Promise<void> {
    this.#assertNotLockedOut();
    if (!this.#header) throw new Error("There is no vault on this device yet.");
    const record = () => this.#recordFailedUnlock();
    const raw = await unwrapPin(this.#header, pin, record);
    await this.#openWithRaw(raw, PIN_MISS);
  }

  /** A primary secret opened the root: keep it, then park it or activate. */
  async #openWithRaw(raw: Uint8Array, miss?: string): Promise<void> {
    this.#stashRaw(raw);
    await this.#afterPrimaryUnwrap(await importVaultKey(raw), miss);
  }

  async probePasskeyCeremony(
    options?: Parameters<typeof probePasskeyCeremony>[1],
  ) {
    return probePasskeyCeremony(this.#passkeyUnlockHost(), options);
  }

  async unlockWithHeldPrf(prfOutput: ArrayBuffer): Promise<void> {
    await unlockVaultWithHeldPrf(this.#passkeyUnlockHost(), prfOutput);
  }

  async unlockWithPasskey(signal?: AbortSignal): Promise<void> {
    await unlockVaultWithPasskey(this.#passkeyUnlockHost(), signal);
  }

  /** Recovery key, age identity or age passkey enrolled in the manifest. */
  async unlockWithProtector(input: ProtectorUnlockInput): Promise<void> {
    await unlockVaultWithProtector(this.#passkeyUnlockHost(), input);
  }

  /** The two phases of `unlockWithProtector`, so a duress gate can sit between. */
  async probeProtector(input: ProtectorUnlockInput): Promise<ArrayBuffer> {
    return probeProtectorRoot(this.#passkeyUnlockHost(), input);
  }

  async unlockWithHeldProtectorRoot(
    root: ArrayBuffer,
    { method }: Pick<ProtectorUnlockInput, "method">,
  ): Promise<void> {
    await unlockVaultWithHeldRoot(this.#passkeyUnlockHost(), root, method);
  }

  #passkeyUnlockHost() {
    return {
      header: () => this.#header,
      assertNotLockedOut: () => this.#assertNotLockedOut(),
      recordFailedUnlock: () => this.#recordFailedUnlock(),
      stashRaw: (raw: Uint8Array) => this.#stashRaw(raw),
      afterPrimaryUnwrap: (vaultKey: CryptoKey, miss?: string) =>
        this.#afterPrimaryUnwrap(vaultKey, miss),
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
    this.#pendingChallenge.clear();
    this.#pendingVaultKey = null;
    this.#pendingCode = null;
    this.#zeroRaw();
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
    this.#sendGuard.assertCanSend();
    const to = await openText(pending, record.toWrap);
    const sent = await sendCode(channel, to);
    this.#sendGuard.noteSent();
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
    // A password set, changed or removed is carried to every device (ADR 0144).
    if (this.#vaultKey && wrapMoved(previous, next, this.#body))
      await this.#mutate((body) => noteMasterWrap(body, next));
  }

  #requireUnlocked() {
    if (!this.#vaultKey || !this.#header) {
      throw new Error("Unlock the vault before changing unlock methods.");
    }
    return { vaultKey: this.#vaultKey, header: this.#header };
  }

  async enrollPasskey(options?: PasskeyCreateOptions): Promise<void> {
    const { header } = this.#requireUnlocked();
    const raw = this.#requireRaw();
    const ceremony = await createPasskeyUnlockCeremony(
      undefined,
      undefined,
      options,
    );
    const record = await wrapVaultKeyWithCeremony(raw, ceremony);
    const unlocks: VaultUnlocks = { ...header.unlocks, passkey: record };
    await this.#persistHeader({ ...header, unlocks });
  }

  async removePasskey(): Promise<void> {
    await this.#removeUnlock("passkey");
  }

  /** Drop one enrolled unlock method, if the vault keeps another primary. */
  async #removeUnlock(method: "passkey" | "pin"): Promise<void> {
    const header = this.#header;
    if (!header?.unlocks?.[method]) return;
    assertKeepsPrimaryUnlock(header, method);
    const { [method]: _removed, ...rest } = header.unlocks;
    await this.#persistHeader({
      ...header,
      unlocks: Object.keys(rest).length ? rest : undefined,
    });
  }

  async enrollPin(pin: string): Promise<void> {
    const { header } = this.#requireUnlocked();
    await assertNewPin(pin);
    const record = await wrapVaultKeyWithPin(this.#requireRaw(), pin);
    const unlocks: VaultUnlocks = { ...header.unlocks, pin: record };
    await this.#persistHeader({ ...header, unlocks });
  }

  async removePin(): Promise<void> {
    await this.#removeUnlock("pin");
  }

  async enrollPassword(password: string): Promise<void> {
    const { header } = this.#requireUnlocked();
    const raw = this.#requireRaw();
    await this.#persistHeader(await headerWithPassword(header, raw, password));
  }

  async removePassword(): Promise<void> {
    if (this.#header?.wrap)
      await this.#persistHeader(headerWithoutPassword(this.#header));
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
    return maskCodeAddress(channel, await openText(vaultKey, record.toWrap));
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
    const { codes, record } = await mintRecoveryCodes(vaultKey);
    await this.#persistHeader({
      ...header,
      unlocks: { ...header.unlocks, recovery: record },
    });
    return codes;
  }

  /** The recovery codes and which are spent, or null when none were made. */
  async recoveryCodes() {
    const { vaultKey, header } = this.#requireUnlocked();
    const record = header.unlocks?.recovery;
    return record ? readRecoveryCodes(vaultKey, record) : null;
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
    const wasDecoy = markDecoySession(false);
    this.#vaultKey = null;
    this.#zeroRaw();
    this.#pendingVaultKey = null;
    this.#pendingTotpSecret = null;
    this.#pendingCode = null;
    this.#pendingCodeAddress = null;
    this.#body = emptyBody();
    syncInstalledTypes(undefined);
    // Guest sessions are ephemeral — wipe ciphertext, but keep the unlock screen on the last guest.
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
      this.#handBackFromGuest(ephemeralTomb, wasDecoy, recordLastVault);
    } else if (recordLastVault) {
      writeLastVaultId(lockedTomb);
    }
    if (ephemeralTomb) void endEphemeralTomb(ephemeralTomb);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#pendingChallenge.clear();
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

  /** Where the unlock screen lands after a guest ends; a decoy returns to the vault it was typed at. */
  #handBackFromGuest(
    ephemeralTomb: string | null,
    wasDecoy: boolean,
    recordLastVault: boolean,
  ): void {
    const toGuest = !wasDecoy || lastVaultIsGuest();
    if (recordLastVault && toGuest) writeLastVaultId(GUEST_TOMB);
    this.#scope = toGuest ? guestVaultScope() : scopedVaultScope();
    this.#header =
      toGuest && ephemeralTomb === GUEST_TOMB ? null : this.#readHeader();
  }

  isUnlocked(): boolean {
    return this.#vaultKey !== null;
  }

  async changeMasterPassword(
    current: string,
    next: string,
    hint?: string,
  ): Promise<void> {
    if (!this.#header) throw new Error("There is no vault to re-key.");
    const header = this.#header;
    await this.#persistHeader(
      await headerWithNewPassword(header, current, next, hint),
    );
  }

  // —— persistence ——————————————————————————————————————————

  async #persist(): Promise<void> {
    if (!this.#vaultKey) throw new Error("The vault is locked.");
    const written = await writeBody(
      this.#scope.tomb,
      this.#vaultKey,
      this.#body,
      this.#header,
    );
    this.#body.rev = written.rev;
    this.#header = written.header;
    // Last: a body that did not finish being recorded is read back, not trusted.
    this.#sealMark = written.mark;
    noteVaultBodyPersisted();
  }

  /**
   * Merge another device's sealed snapshot of this vault (ADR 0144). Reports
   * whether this device changed and whether the snapshot is now behind it.
   */
  async mergeSnapshot(input: DriveSnapshotInput): Promise<SnapshotMerge> {
    const { vaultKey, header } = this.#requireUnlocked();
    await this.flushPendingWrites();
    const port = this.#bodyPort();
    const merged = await mergeSnapshotInto(port, vaultKey, header, input);
    // Another device's password change arrives in the body (`master-wrap.ts`).
    const adopted = this.#header && adoptedMasterWrap(this.#body, this.#header);
    if (adopted) await this.#persistHeader(adopted);
    return merged;
  }

  /** This vault's header and sealed body as stored, once pending writes land. */
  async sealedSnapshot(): Promise<SealedSnapshot> {
    const { header } = this.#requireUnlocked();
    await this.flushPendingWrites();
    const body = readSealedFile(this.#scope.tomb, BODY_PATH);
    if (!body) throw new Error("There is nothing stored to sync yet.");
    return { tomb: this.#scope.tomb, header, body, rev: this.#body.rev ?? 0 };
  }

  /** Apply a mutation and seal it, in the order requested (a rename per keystroke). */
  #mutate(change: (body: VaultBody) => void): Promise<void> {
    return this.#exclusive((apply) => apply(stampedEdit(change)));
  }

  /**
   * Run `act` as the next write: on the write chain, then under the cross-tab
   * body lock, from the disk's body when another tab wrote since this one did.
   * Chain, then lock, is the one order (`destroy` too), so neither waits on
   * the other. `act` writes through `apply`, which never queues again.
   */
  #exclusive<T>(act: (apply: ApplyChange) => Promise<T>): Promise<T> {
    const run = this.#writeChain.then(() => {
      const vaultKey = this.#vaultKey;
      if (!vaultKey) throw new Error("The vault is locked.");
      return withBodyWriteLockOrBare(this.#scope.tomb, async () => {
        const fresh = await freshBody(
          this.#scope.tomb,
          vaultKey,
          { header: this.#header, body: this.#body, mark: this.#sealMark },
          () => (this.#sharesDisk() ? this.#readHeader() : null),
        );
        this.#header = fresh.header;
        if (fresh.body) {
          this.#body = fresh.body;
          syncInstalledTypes(fresh.body.itemTypes);
          this.#emit();
        }
        return act((change) => this.#apply(change));
      });
    });
    this.#writeChain = run.catch(() => undefined);
    return run;
  }

  /** A guest or scratch session is never exported or synced, and its tomb has no header of its own. */
  #sharesDisk(): boolean {
    return !this.#ephemeral && !isGuestSessionTomb(this.#scope.tomb);
  }

  async #apply(change: (body: VaultBody) => void): Promise<void> {
    if (!this.#vaultKey) throw new Error("The vault is locked.");
    // Keep the pre-change body: a failed write must not leave memory ahead of disk.
    const previous = bodyBeforeWrite(this.#body);
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

  saveItem(item: VaultItem, folder?: Folder): Promise<void> {
    return writeSavedItems(this.#writes(), [item], folder);
  }

  saveItems(items: readonly VaultItem[], folder?: Folder): Promise<void> {
    return writeSavedItems(this.#writes(), items, folder);
  }

  #writes(): ItemWriteHost {
    return {
      tomb: this.#scope.tomb,
      items: resolveAccounts(this.#body.items),
      mutate: (change) => this.#mutate(change),
    };
  }

  async trashItem(id: string): Promise<void> {
    await this.#discard("trash", id);
  }

  async restoreItem(id: string): Promise<void> {
    await this.#mutate((body) => restoreItem(body, id));
  }

  async purgeItem(id: string): Promise<void> {
    await this.#discard("purge", id);
  }

  async emptyTrash(): Promise<void> {
    await this.#discard("empty", "");
  }

  /** A trashed drop that synced here still has its claim on this device. */
  reconcileTrashedShares(): Promise<void> {
    const items = this.getSnapshot().items;
    return revokeTrashedShares(items, (change) => this.#mutate(change));
  }

  #discard(kind: "trash" | "purge" | "empty", id: string): Promise<void> {
    const items = this.getSnapshot().items;
    return commitDiscard(kind, items, id, (change) => this.#mutate(change));
  }

  /** Take items out of the body without a trace: no tombstone, trash or note (ADR 0171). */
  async withdrawItems(plan: ItemWithdrawal): Promise<void> {
    await this.#mutate((body) => withdrawFromBody(body, plan));
  }

  /** Put withdrawn items back as they were, ids and times intact (ADR 0171). */
  async restoreWithdrawn(back: ItemReturn): Promise<void> {
    await this.#mutate((body) => restoreIntoBody(body, back));
  }

  async toggleFavorite(id: string): Promise<void> {
    await this.#mutate((body) => toggleFavorite(body, id));
  }

  async replaceAll(items: VaultItem[], folders: Folder[]): Promise<void> {
    await this.#mutate((body) => replaceItems(body, items, folders));
  }

  async addItems(items: VaultItem[]): Promise<void> {
    await this.#mutate((body) => appendItems(body, items, []));
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
    const { adds, updates, newFolders } = plan;
    if (adds.length + updates.length + newFolders.length === 0) return;
    await this.#mutate((body) => applyManifestPlan(body, plan));
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
    await this.#mutate((body) =>
      appendItems(body, plan.items, plan.newFolders),
    );
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
    await this.#mutate((body) => deleteFolder(body, id));
  }

  // —— export / import ——————————————————————————————————————

  /** Encrypted export — the sealed body plus its header, portable to another device. */
  exportSealed(): string {
    return sealedVaultExport(this.#header, this.#scope.tomb);
  }

  /** Import a sealed export with its password, its PIN, or an unwrapped key. */
  importSealed(
    fileText: string,
    secret: string | Uint8Array,
    options: ImportOptions = {},
  ): Promise<number> {
    return importSealedInto(this.#bodyPort(), fileText, secret, options);
  }

  #bodyPort(): VaultBodyPort {
    return makeBodyPort({
      tomb: () => this.#scope.tomb,
      open: () => this.#vaultKey !== null,
      carries: () => this.#sharesDisk(),
      header: () => this.#header,
      body: () => this.#body,
      exclusive: (act) => this.#exclusive(act),
    });
  }

  /** Irreversibly remove the vault from this device. */
  async destroy(): Promise<void> {
    // The files to remove are the ones this session was using. Captured
    // before `lock()`: a guest deleting "this vault" deletes the guest tomb,
    // never the sealed vault it was running beside. After wipe, hand the
    // unlock screen back to the personal vault — destroy leaves guest, it
    // does not lock guest for re-entry.
    const scope = this.#scope;
    // As final as locking: the same teardown (clipboard, Identity, claims).
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
        // Awaited — resolves once the files are gone; leftover ciphertext would break a fresh vault.
        await withExclusiveOpenLease(scope.tomb, () =>
          withBodyWriteLock(scope.tomb, async () => {
            await Promise.all([
              deletePlaintextFile(scope.tomb, HEADER_PATH),
              discardVaultBody(scope.tomb),
              kvDeleteDurable(scope.attempts),
              wipeTombOnDestroy(scope.tomb),
            ]);
          }),
        );
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

export const vaultStore = bindGuestSessionStore(new VaultStore());

// The device identity host mints through this store's body (ADR 0160 §5).
installDeviceKeyCarrier(() => bodyPortOf(vaultStore));

// A guest's tomb is sealed and isolated like any other, so a guest's
// actions are logged in it (PRODUCT.md: guests are first-class).
activitySeams.activeTomb = () => {
  const snap = vaultStore.getSnapshot();
  return snap.status === "unlocked" && snap.tomb ? snap.tomb : null;
};

export { WrongPasswordError, VaultCorruptError };
