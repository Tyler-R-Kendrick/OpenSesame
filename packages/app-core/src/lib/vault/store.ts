import {
  type Folder,
  type InstallResult,
  type VaultBody,
  VaultCorruptError,
  type VaultHeader,
  type VaultItem,
  WrongPasswordError,
  emptyBody,
  syncInstalledTypes,
} from "@opensesame/vault-core";
import {
  noteVaultBodyPersisted,
  noteVaultUnlocked,
  recordActivityEvent,
} from "../activity-log.js";
import { assertNotDecoySession } from "../decoy-session.js";
import {
  endEphemeralTomb,
  forgetDecoyScratch,
  isGuestSessionTomb,
} from "../duress/store/decoy-scratch.js";
import { createDuressVaultActivationHost } from "../duress/store/vault-activation-host.js";
import { sessionRootDigestFromKey } from "../duress/store/vault-session-digest.js";
import { kvDelete } from "../kv.js";
import { writeLastVaultId } from "../last-vault.js";
import { recordKeyAdmission } from "../vfs-authority.js";
import type { WriteOperation } from "../vfs-write-contract.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  lockTomb,
  readSealedFile,
  unlockTomb,
} from "../vfs.js";
import {
  appendItems,
  applyManifestPlan,
  deleteFolder,
  emptyTrash,
  purgeItem,
  renameFolder,
  replaceItems,
  restoreItem,
  stampedEdit,
  toggleFavorite,
  trashItem,
} from "./body-edits.js";
import { headerCarriesGate } from "./header-gate.js";
import {
  type ItemReturn,
  type ItemWithdrawal,
  restoreIntoBody,
  withdrawFromBody,
} from "./item-departure.js";
import { type ItemWriteHost, writeSavedItems } from "./item-writes.js";
import { emitVaultLock } from "./lock-events.js";
import { adoptedMasterWrap } from "./master-wrap.js";
import {
  type PasskeyProbeOptions,
  unlockVaultWithHeldPrf,
  unlockVaultWithPasskey,
  wrapVaultKeyWithCeremony,
} from "./passkey-unlock-session.js";
import {
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
import {
  type ProtectorUnlockInput,
  unlockVaultWithHeldRoot,
  unlockVaultWithProtector,
} from "./protector-unlock-session.js";
import { type SentCode, sendCode, verifyCode } from "./remote-code.js";
import { carryForkUnlockedIntoActiveScope } from "./scope-carry-fork.js";
import { carryOpenActiveScopeWithCurrentKey } from "./scope-carry-open.js";
import { CodeSendGuard, PendingChallenge } from "./second-step-guard.js";
import { loadActivatedVault } from "./store-activation-load.js";
import { StoreAuthenticationAdmission } from "./store-auth-admission.js";
import { makeGuardedBodyPort } from "./store-body-host.js";
import { applyGuardedBodyChange } from "./store-body-mutation.js";
import { loadVaultBody } from "./store-body.js";
import * as creation from "./store-creation.js";
import { queueStoreDestruction } from "./store-destroy-queue.js";
import {
  type ApplyChange,
  type VaultBodyPort,
  bodyPortOf,
  installDeviceKeyCarrier,
  levelDeviceKey,
  registerBodyPort,
} from "./store-device-key.js";
import { queueExclusiveBodyWrite, sharesBody } from "./store-exclusive.js";
import { exportSealedVault } from "./store-export.js";
import { sealMark } from "./store-fresh.js";
import { guestHandBack } from "./store-guest-handback.js";
import { prepareGuestSession } from "./store-guest-key.js";
import * as headerStore from "./store-header-persist.js";
import {
  deviceHoldsSealedVault,
  readTombHeader,
  sharesWrapRecord,
} from "./store-header.js";
import { scheduleIdleLock } from "./store-idle.js";
import { type ImportOptions, importSealedInto } from "./store-import-loader.js";
import * as itemTypes from "./store-item-types.js";
import {
  type BodyEdit,
  type Check,
  type Items,
  itemWriteHost,
} from "./store-item-write-host.js";
import {
  type DriveSnapshotInput,
  type SealedSnapshot,
  type SnapshotMerge,
  mergeSnapshotInto,
} from "./store-merge.js";
import { pinStoreOperation } from "./store-operation-guard.js";
import {
  changePasswordHeader,
  createPasswordVault,
  enrollPasswordHeader,
  removePasswordHeader,
  removeSecondStepHeader,
  removeUnlockHeader,
} from "./store-passwords.js";
import { continuePrimarySession } from "./store-primary-session.js";
import * as storeRealm from "./store-realm.js";
import {
  describeSessionCodeChannel,
  generateSessionRecoveryCodes,
  readSessionRecoveryCodes,
} from "./store-recovery.js";
import { rotateRootDataset } from "./store-root-rotation-loader.js";
import { writeBody } from "./store-seal.js";
import { installVaultSessionHooks } from "./store-session-hooks.js";
import { loadSessionPrefs, queueSessionPrefs } from "./store-session-prefs.js";
import * as stateView from "./store-state-snapshot.js";
import * as totpEnrollment from "./store-totp-enrollment.js";
import { vaultIdentity } from "./store-vault-identity.js";
import { discardTombCaches } from "./tomb-migration.js";
import {
  type CodeChannel,
  type TotpGateRecord,
  type VaultUnlocks,
  createPasskeyUnlockCeremony,
  openText,
  openTotpSecret,
  primaryUnlockCount,
  sealText,
  totpCodeMatches,
  wrapVaultKeyWithPin,
} from "./unlock-methods.js";
import { assertNewPin } from "./unlock-secret-guard.js";
export { deviceHoldsSealedVault, readTombHeader, sharesWrapRecord };
export { PREFS_CONFIG_PATH, PREFS_SOURCE_CONFIG_PATH } from "./prefs-io.js";

/** Guest-beside-vault tomb — isolated, throwaway, never a project id. */
export { GUEST_TOMB };
import { unlockWithPassword, unlockWithPin } from "./primary-unlock-session.js";
import {
  ATTEMPTS_KEY,
  type VaultScope,
  guestVaultScope,
  scopedVaultScope,
} from "./store-scope.js";
import { assertNotLockedOut, recordFailedUnlock } from "./unlock-attempts.js";
export { ATTEMPTS_KEY };
export {
  type VaultPrefs,
  VAULT_PREFS_REVISION,
  assertMasterPasswordPolicy,
  defaultPrefs,
  normalizeVaultPrefs,
} from "./prefs.js";

import type { VaultState } from "./store-state.js";
export type { VaultState, VaultStatus } from "./store-state.js";

type Listener = () => void;

export class VaultStore {
  #vaultKey: CryptoKey | null = null;
  /** Raw VK for enroll-only wrapKey substitutes; wiped on lock and cancel. */
  #rawVaultKey: Uint8Array | null = null;
  readonly #authAdmission = new StoreAuthenticationAdmission(
    () => this.#header,
    () => this.#requireRaw(),
  );
  #ownedSyntheticRealm: number | null = null;
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
    this.#header = readTombHeader(this.#scope.tomb);
    registerBodyPort(this, () => this.#bodyPort());
    this.#protection = new VaultProtectionBrowserService({
      isGuestOrEphemeral: () =>
        this.#ephemeral || this.#scope.tomb === GUEST_TOMB,
      getHeader: () => this.#header,
      requireRawRoot: () => this.#requireRaw(),
      isUnlocked: () => this.#vaultKey !== null && this.#header !== null,
      persistHeader: (next) => this.#persistHeader(next, this.#pinOperation()),
      replaceRawVaultKey: (next, header) =>
        this.#replaceRawVaultKey(next, header),
      session: this.#sessionGuard,
      pinContext: (admission) => this.#pinOperation(admission),
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
    this.#scope = storeRealm.restoredLockedScope();
    const header = readTombHeader(this.#scope.tomb);
    this.#header =
      this.#scope.tomb === GUEST_TOMB && !headerCarriesGate(header)
        ? null
        : header;
    this.#emit();
  }

  /** Drop the previous project session and read the active project's header. */
  loadActiveProjectScope(): void {
    // Explicit project swap — lock() must not keep the destination tomb as last-vault.
    this.lock({ recordLastVault: false });
    this.#scope = scopedVaultScope();
    this.#header = readTombHeader(this.#scope.tomb);
    writeLastVaultId(this.#scope.tomb);
    this.#emit();
  }

  /** Carry this unlock into the active project (shared device key). */
  async forkUnlockedIntoActiveScope(): Promise<void> {
    await carryForkUnlockedIntoActiveScope({
      pinContext: (admission) => this.#pinOperation(admission),
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
  activeTomb = (): string => this.#scope.tomb;
  /** Pin an asynchronous continuation to this admitted session. */
  pinContinuation = (): (() => void) => this.#pinOperation();

  /** Await in-flight body persists before duress activation or scope carries. */
  async flushPendingWrites(): Promise<void> {
    await this.#writeChain.catch(() => undefined);
  }

  #sessionRootDigest(): Promise<string | null> {
    this.#pinOperation()();
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
      pinContext: (admission) => this.#pinOperation(admission),
      cancelPendingOps: () => this.#protection.cancelPendingOps(),
      vaultKey: this.#vaultKey,
      header: this.#header,
      ephemeral: this.#ephemeral,
      scope: this.#scope,
      body: this.#body,
      sessionRootDigest: () => this.#sessionRootDigest(),
      lockHandlers: [...this.#lockHandlers],
      activateSession: (key, check) => this.#activateSession(key, check, false),
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

  #pinOperation(allowKeyAdmission = false): () => void {
    return pinStoreOperation(
      () => ({
        scope: this.#scope,
        generation: this.#sessionGuard.generation,
        vaultKey: this.#vaultKey,
        pendingVaultKey: this.#pendingVaultKey,
      }),
      allowKeyAdmission,
    );
  }

  #persistPrefs(): void {
    if (!this.#vaultKey) return;
    this.#writeChain = queueSessionPrefs(
      this.#writeChain.then(() => undefined),
      this.#scope.tomb,
      this.#prefs,
      this.#pinOperation(),
      {
        root: [this.#vaultKey, () => this.#requireRaw()],
        current: () => this.#prefs,
        restore: (prefs) => {
          this.#prefs = prefs;
          this.#armIdleTimer();
          this.#emit();
        },
      },
    );
  }

  #build(): VaultState {
    return stateView.buildVaultState({
      scope: this.#scope,
      unlocked: this.#vaultKey !== null,
      ephemeral: this.#ephemeral,
      pending: this.#pendingVaultKey !== null,
      header: this.#header,
      body: this.#body,
      prefs: this.#prefs,
    });
  }

  #emit(): void {
    this.#snapshot = this.#build();
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): VaultState =>
    stateView.visibleVaultState(
      this.#snapshot,
      this.#scope.tomb,
      this.#vaultKey,
    );

  // —— session ——————————————————————————————————————————————

  #stashRaw(raw: Uint8Array): void {
    this.#zeroRaw();
    this.#rawVaultKey = raw;
  }

  #zeroRaw(): void {
    this.#rawVaultKey?.fill(0);
    this.#rawVaultKey = null;
  }

  #discardSessionRoot(): void {
    this.#vaultKey = null;
    this.#pendingVaultKey = null;
    lockTomb(this.#scope.tomb);
    this.#zeroRaw();
    this.#body = emptyBody();
  }

  #requireRaw(): Uint8Array {
    this.#pinOperation()();
    if (!this.#rawVaultKey) {
      throw new Error("Unlock the vault before changing unlock methods.");
    }
    return this.#rawVaultKey;
  }

  async #replaceRawVaultKey(
    next: Uint8Array,
    header: VaultHeader,
  ): Promise<void> {
    const check = this.#pinOperation(true);
    const run = rotateRootDataset(
      this.#writeChain.then(() => undefined),
      this.#scope.tomb,
      this.#vaultKey,
      this.#header,
      next,
      header,
      check,
    );
    this.#writeChain = run.catch(() => undefined);
    const result = await run;
    check();
    this.#vaultKey = result.key;
    this.#header = result.header;
    this.#body = result.body;
    this.#stashRaw(next);
    unlockTomb(this.#scope.tomb, result.key);
    this.#sealMark = sealMark(this.#scope.tomb);
    this.#emit();
  }

  async create(password: string, hint?: string): Promise<void> {
    this.#protection.cancelPendingOps();
    const assertCurrent = this.#pinOperation(true);
    await createPasswordVault(
      this.#scope.tomb,
      password,
      hint,
      (header, key, raw) =>
        this.#persistNewVault(header, key, raw, assertCurrent),
    );
  }

  /** First-run seal under a passkey PRF wrap — no master password required. */
  async createWithPasskey(signal?: AbortSignal): Promise<void> {
    this.#protection.cancelPendingOps();
    await creation.createPasskeyVault(
      signal,
      this.#pinOperation(true),
      (header, key, raw, check) =>
        this.#persistNewVault(header, key, raw, check),
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
    this.#discardSessionRoot();
    this.#ephemeral = false;
    writeLastVaultId(GUEST_TOMB);
    this.#emit();
  }

  async createGuest(options?: {
    resume?: boolean;
    decoy?: boolean;
    isolated?: boolean;
  }): Promise<void> {
    if (this.#vaultKey || this.#pendingVaultKey) {
      throw new Error("Lock the open vault before continuing as a guest.");
    }
    // Guests run in GUEST_TOMB, apart from member tombs; a decoy never wipes a
    // guest tomb that holds its own key: it runs in a scratch tomb.
    this.#protection.cancelPendingOps();
    this.#ownedSyntheticRealm = storeRealm.beginGuestRealm(
      options?.decoy === true,
      this.#scope.tomb,
      vaultIdentity(this.#header),
    );
    const assertCurrent = this.#pinOperation();
    const { vaultKey, rawVaultKey, scope } = await prepareGuestSession(
      options,
      assertCurrent,
    );
    try {
      assertCurrent();
    } catch (error) {
      rawVaultKey.fill(0);
      throw error;
    }
    this.#scope = scope;
    this.#header = {
      v: 1,
      createdAt: new Date().toISOString(),
    };
    this.#vaultKey = vaultKey;
    this.#stashRaw(rawVaultKey);
    this.#pendingVaultKey = null;
    this.#body = emptyBody();
    this.#ephemeral = true;
    unlockTomb(this.#scope.tomb, vaultKey, options?.decoy === true);
    // A decoy leaves the unlock screen on the vault it was typed at.
    if (!options?.decoy) writeLastVaultId(GUEST_TOMB);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
  }

  /** First-run seal under a PIN wrap — no master password required. */
  async createWithPin(pin: string): Promise<void> {
    this.#protection.cancelPendingOps();
    await creation.createPinVault(
      pin,
      this.#pinOperation(true),
      (header, key, raw, check) =>
        this.#persistNewVault(header, key, raw, check),
    );
  }

  async #persistNewVault(
    initial: VaultHeader,
    vaultKey: CryptoKey,
    raw: Uint8Array,
    assertCurrent: () => void,
  ): Promise<void> {
    const header = await creation.sealNewHeader(initial, raw, assertCurrent);
    assertCurrent();
    this.#header = header;
    this.#vaultKey = vaultKey;
    this.#stashRaw(raw);
    this.#pendingVaultKey = null;
    this.#body = emptyBody();
    this.#ephemeral = false;
    const scope = this.#scope;
    unlockTomb(scope.tomb, vaultKey);
    const check = this.#pinOperation();
    await creation.persistCreatedVault({
      tomb: scope.tomb,
      header,
      key: vaultKey,
      assertCurrent: check,
      persist: () => this.#persist(),
      loadPrefs: async () => {
        const prefs = await loadSessionPrefs(scope.tomb, this.#prefs, check);
        check();
        this.#prefs = prefs;
      },
      reset: () => {
        this.#header = null;
        this.#discardSessionRoot();
        this.#emit();
      },
    });
    check();
    kvDelete(scope.attempts);
    writeLastVaultId(scope.tomb);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
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
    storeRealm.refuseFrozenPrimaryProof(
      this.#scope.tomb,
      () => this.#recordFailedUnlock(),
      () => this.#vaultKey !== null,
      () => this.cancelTotpChallenge(),
      miss,
    );
  }

  async #activateSession(
    vaultKey: CryptoKey,
    assertCurrent: () => void,
    freshAuthentication: boolean,
  ): Promise<void> {
    assertCurrent();
    const scope = this.#scope;
    const header = this.#header;
    this.#refuseWhileFrozen();
    const publish = () => {
      this.#vaultKey = vaultKey;
      this.#pendingVaultKey = null;
      this.#pendingChallenge.clear();
      unlockTomb(scope.tomb, vaultKey);
    };
    try {
      if (freshAuthentication)
        await this.#authAdmission.activate(
          vaultKey,
          scope.tomb,
          assertCurrent,
          publish,
        );
      else publish();
      const loaded = await loadActivatedVault(
        scope.tomb,
        vaultKey,
        header,
        this.#prefs,
        assertCurrent,
      );
      assertCurrent();
      this.#prefs = loaded.prefs;
      this.#body = loaded.body;
      this.#sealMark = loaded.mark;
      syncInstalledTypes(this.#body.itemTypes);
      await levelDeviceKey(this.#bodyPort());
      assertCurrent();
      await this.#protection.ensureProtectionProjected();
      assertCurrent();
    } catch (error) {
      assertCurrent();
      this.#discardSessionRoot();
      throw error;
    }
    kvDelete(this.#scope.attempts);
    writeLastVaultId(this.#scope.tomb);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
    noteVaultUnlocked();
  }
  async #afterPrimaryUnwrap(
    vaultKey: CryptoKey,
    miss: string | undefined,
    assertCurrent: () => void,
  ) {
    return continuePrimarySession({
      header: this.#header,
      assertCurrent,
      refuse: () => this.#refuseWhileFrozen(miss),
      park: () => {
        recordKeyAdmission(vaultKey);
        this.#pendingVaultKey = vaultKey;
      },
      loadBody: () => loadVaultBody(this.#scope.tomb, vaultKey, this.#header),
      confirmTotp: (code) => this.confirmTotp(code),
      activate: () => this.#activateSession(vaultKey, assertCurrent, true),
      armChallenge: () => {
        this.#sendGuard.reset();
        this.#pendingChallenge.arm(() => {
          if (this.#pendingVaultKey === vaultKey) this.cancelTotpChallenge();
        });
        this.#emit();
      },
    });
  }

  async unlock(password: string): Promise<void> {
    await unlockWithPassword(await this.#passkeyUnlockHost(), password);
  }

  async unlockWithPin(pin: string): Promise<void> {
    await unlockWithPin(await this.#passkeyUnlockHost(), pin);
  }

  async probePasskeyCeremony(options?: PasskeyProbeOptions) {
    return this.#authAdmission.probePasskey(
      await this.#passkeyUnlockHost(),
      options,
      this.#scope.tomb,
    );
  }

  async unlockWithHeldPrf(prfOutput: ArrayBuffer): Promise<void> {
    await this.#authAdmission.assertHeld(prfOutput, this.#scope.tomb);
    await unlockVaultWithHeldPrf(await this.#passkeyUnlockHost(), prfOutput);
  }

  async unlockWithPasskey(signal?: AbortSignal): Promise<void> {
    await unlockVaultWithPasskey(await this.#passkeyUnlockHost(), signal);
  }

  /** Recovery key, age identity or age passkey enrolled in the manifest. */
  async unlockWithProtector(input: ProtectorUnlockInput): Promise<void> {
    await unlockVaultWithProtector(await this.#passkeyUnlockHost(), input);
  }

  /** The two phases of `unlockWithProtector`, so a duress gate can sit between. */
  async probeProtector(input: ProtectorUnlockInput): Promise<ArrayBuffer> {
    return this.#authAdmission.probeProtector(
      await this.#passkeyUnlockHost(),
      input,
      this.#scope.tomb,
    );
  }

  async unlockWithHeldProtectorRoot(
    root: ArrayBuffer,
    { method }: Pick<ProtectorUnlockInput, "method">,
  ): Promise<void> {
    await this.#authAdmission.assertHeld(root, this.#scope.tomb);
    await unlockVaultWithHeldRoot(
      await this.#passkeyUnlockHost(),
      root,
      method,
    );
  }

  #passkeyUnlockHost() {
    this.#protection.cancelPendingOps();
    return this.#authAdmission.createHost(
      this.#scope,
      this.#pinOperation(true),
      (header) => {
        this.#header = header;
      },
      () => this.#recordFailedUnlock(),
      (raw) => this.#stashRaw(raw),
      (key, miss, check) => this.#afterPrimaryUnwrap(key, miss, check),
    );
  }

  async confirmTotp(code: string): Promise<void> {
    const assertCurrent = this.#pinOperation(true);
    assertNotLockedOut(this.#scope.attempts);
    const pending = this.#pendingVaultKey;
    const gate = this.#header?.unlocks?.totp;
    if (!pending || !gate) {
      throw new Error("Enter a primary unlock method first.");
    }
    const secret = await openTotpSecret(pending, gate);
    assertCurrent();
    const ok = await totpCodeMatches(secret, code, gate.digits, gate.period);
    assertCurrent();
    if (!ok) {
      this.#recordFailedUnlock();
      throw new WrongPasswordError("That authenticator code is not valid.");
    }
    await this.#activateSession(pending, assertCurrent, true);
    assertCurrent();
    // A gate with no registration yet gets one now (ADR 0113).
    if (!gate.selfItemId)
      await this.#registerSelfAuthenticator(gate, assertCurrent);
  }

  cancelTotpChallenge(): void {
    this.#protection.cancelPendingOps();
    this.#pendingChallenge.clear();
    this.#pendingVaultKey = null;
    this.#pendingCode = null;
    this.#zeroRaw();
    this.#emit();
  }

  /** Step 2 by email/text: send a code to the sealed address. */
  async requestSecondStepCode(channel: CodeChannel): Promise<SentCode> {
    const assertCurrent = this.#pinOperation(true);
    assertNotLockedOut(this.#scope.attempts);
    const pending = this.#pendingVaultKey;
    const record = this.#header?.unlocks?.[channel];
    if (!pending || !record) {
      throw new Error("Enter a primary unlock method first.");
    }
    this.#sendGuard.assertCanSend();
    const to = await openText(pending, record.toWrap);
    assertCurrent();
    const sent = await sendCode(
      channel,
      to,
      this.#authAdmission.permit(pending, this.#scope.tomb),
    );
    assertCurrent();
    this.#sendGuard.noteSent();
    this.#pendingCode = sent;
    this.#emit();
    return sent;
  }

  pendingSecondStepCode(): SentCode | null {
    return this.#pendingCode;
  }

  /**
   * Confirm a code the Identity API sent. The service says yes or no; a no
   * counts toward the lockout exactly as a wrong authenticator code does.
   */
  async confirmRemoteCode(code: string): Promise<void> {
    const assertCurrent = this.#pinOperation(true);
    assertNotLockedOut(this.#scope.attempts);
    const pending = this.#pendingVaultKey;
    const sent = this.#pendingCode;
    if (!pending || !sent) {
      throw new Error("Ask for a code first.");
    }
    try {
      await verifyCode(
        sent.challengeId,
        code,
        this.#authAdmission.permit(pending, this.#scope.tomb),
      );
      assertCurrent();
    } catch (error) {
      assertCurrent();
      this.#recordFailedUnlock();
      throw error;
    }
    this.#pendingCode = null;
    await this.#activateSession(pending, assertCurrent, true);
  }

  /** Spend a recovery code as the second step (see `recovery-codes.ts`). */
  async redeemRecoveryCode(code: string): Promise<void> {
    const assertCurrent = this.#pinOperation(true);
    assertNotLockedOut(this.#scope.attempts);
    const pending = await this.#authAdmission.spendRecovery(
      this.#pendingVaultKey,
      this.#scope.tomb,
      code,
      assertCurrent,
      (next) => this.#persistHeader(next, assertCurrent),
      () => this.#recordFailedUnlock(),
    );
    assertCurrent();
    this.#pendingCode = null;
    await this.#activateSession(pending, assertCurrent, true);
  }

  async #persistHeader(
    next: VaultHeader,
    assertCurrent: () => void,
  ): Promise<void> {
    await headerStore.persistStoreHeaderWithConnectorTransfer({
      snapshot: this.getSnapshot,
      project: () => this.#protection.ensureProtectionProjected(),
      tomb: this.#scope.tomb,
      previous: this.#header,
      next,
      assertCurrent,
      assignHeader: (header) => {
        this.#header = header;
      },
      committed: () => {
        this.#ephemeral = false;
      },
      emit: () => this.#emit(),
      masterWrap: {
        ephemeral: () => this.#ephemeral,
        body: () => this.#body,
        root: () => [this.#vaultKey, () => this.#requireRaw()],
        mutate: (change) => this.#mutate(change),
      },
    });
  }
  #requireUnlocked() {
    return headerStore.requireUnlockedVault(this.#vaultKey, this.#header);
  }

  async enrollPasskey(): Promise<void> {
    const assertCurrent = this.#pinOperation();
    const { header } = this.#requireUnlocked();
    const raw = this.#requireRaw();
    const ceremony = await createPasskeyUnlockCeremony();
    assertCurrent();
    const record = await wrapVaultKeyWithCeremony(raw, ceremony);
    assertCurrent();
    const unlocks: VaultUnlocks = { ...header.unlocks, passkey: record };
    await this.#persistHeader({ ...header, unlocks }, assertCurrent);
  }

  async removePasskey(): Promise<void> {
    await this.#removeUnlock("passkey");
  }

  /** Drop one enrolled unlock method, if the vault keeps another primary. */
  async #removeUnlock(method: "passkey" | "pin"): Promise<void> {
    const assertCurrent = this.#pinOperation();
    await removeUnlockHeader(this.#header, method, (header) =>
      this.#persistHeader(header, assertCurrent),
    );
    assertCurrent();
  }

  async enrollPin(pin: string): Promise<void> {
    const assertCurrent = this.#pinOperation();
    assertNotDecoySession();
    const { header } = this.#requireUnlocked();
    await assertNewPin(pin);
    assertCurrent();
    const record = await wrapVaultKeyWithPin(this.#requireRaw(), pin);
    assertCurrent();
    const unlocks: VaultUnlocks = { ...header.unlocks, pin: record };
    await this.#persistHeader({ ...header, unlocks }, assertCurrent);
  }

  async removePin(): Promise<void> {
    await this.#removeUnlock("pin");
  }

  async enrollPassword(password: string): Promise<void> {
    const assertCurrent = this.#pinOperation();
    const { header } = this.#requireUnlocked();
    await enrollPasswordHeader(
      this.#scope.tomb,
      header,
      () => {
        assertCurrent();
        return this.#requireRaw();
      },
      password,
      (next) => this.#persistHeader(next, assertCurrent),
    );
    assertCurrent();
  }

  async removePassword(): Promise<void> {
    const assertCurrent = this.#pinOperation();
    await removePasswordHeader(this.#header, (header) =>
      this.#persistHeader(header, assertCurrent),
    );
    assertCurrent();
  }

  /**
   * Start enrolling an authenticator code as the second step. Returns an
   * otpauth URI; the gate is written only once a code matches.
   */
  async beginTotpEnrollment(): Promise<string> {
    const started = totpEnrollment.startSessionTotpEnrollment(
      this.#ephemeral,
      this.#requireUnlocked().header,
    );
    this.#pendingTotpSecret = started.secret;
    return started.uri;
  }

  /**
   * Prove the authenticator was set up, turn the gate on, and register the
   * vault as its own authenticator (ADR 0113).
   */
  async confirmTotpEnrollment(code: string): Promise<void> {
    const assertCurrent = this.#pinOperation();
    const { vaultKey, header } = this.#requireUnlocked();
    await totpEnrollment.confirmSessionTotpEnrollment({
      vaultKey,
      header,
      ephemeral: this.#ephemeral,
      secret: this.#pendingTotpSecret,
      code,
      assertCurrent,
      persist: (next) => this.#persistHeader(next, assertCurrent),
      register: (gate) => this.#registerSelfAuthenticator(gate, assertCurrent),
      clearSecret: () => {
        this.#pendingTotpSecret = null;
      },
    });
  }

  /** Abandon an enrollment that never saw a matching code. */
  cancelTotpEnrollment(): void {
    this.#pendingTotpSecret = null;
  }

  /** Point a gate at its self-authenticator registration (ADR 0113). */
  async #registerSelfAuthenticator(
    gate: TotpGateRecord,
    assertCurrent: () => void,
  ): Promise<void> {
    assertCurrent();
    if (!this.#header || !this.#vaultKey) return;
    await totpEnrollment.registerSessionSelfAuthenticator({
      header: this.#header,
      vaultKey: this.#vaultKey,
      body: this.#body,
      gate,
      assertCurrent,
      save: (item) => this.saveItem(item),
      persist: (next) => this.#persistHeader(next, assertCurrent),
    });
  }

  async removeTotp(): Promise<void> {
    await this.#removeSecondStep("totp");
  }

  /** Drop one second step; the last one takes the recovery codes with it. */
  async #removeSecondStep(step: "totp" | CodeChannel): Promise<void> {
    const assertCurrent = this.#pinOperation();
    await removeSecondStepHeader(
      this.#header,
      step,
      (id) => this.trashItem(id),
      assertCurrent,
      (header) => this.#persistHeader(header, assertCurrent),
    );
  }

  /** Enroll email/text code; nothing is written until a code matches. */
  async beginCodeEnrollment(
    channel: CodeChannel,
    to: string,
  ): Promise<SentCode> {
    const assertCurrent = this.#pinOperation();
    const { header } = this.#requireUnlocked();
    if (this.#ephemeral || primaryUnlockCount(header) === 0) {
      throw new Error(
        "Seal this vault with a passkey, PIN or password before adding a code by email or text — a code can only guard a key.",
      );
    }
    const sent = await sendCode(channel, to.trim());
    assertCurrent();
    this.#pendingCode = sent;
    this.#pendingCodeAddress = { channel, to: to.trim() };
    return sent;
  }

  /** Prove the first code arrived, then seal the address and turn it on. */
  async confirmCodeEnrollment(code: string): Promise<void> {
    const assertCurrent = this.#pinOperation();
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
    assertCurrent();
    const toWrap = await sealText(vaultKey, address.to);
    assertCurrent();
    const unlocks: VaultUnlocks = {
      ...header.unlocks,
      [address.channel]: { toWrap, since: new Date().toISOString() },
    };
    await this.#persistHeader({ ...header, unlocks }, assertCurrent);
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
    const assertCurrent = this.#pinOperation();
    const { vaultKey, header } = this.#requireUnlocked();
    return describeSessionCodeChannel(vaultKey, header, channel, assertCurrent);
  }

  /**
   * Make (or remake) the recovery codes. Sealed under the vault key, so
   * Settings can show the ones left while the vault is open; a new set
   * replaces the old one whole.
   */
  async generateRecoveryCodes(): Promise<string[]> {
    const assertCurrent = this.#pinOperation();
    const { vaultKey, header } = this.#requireUnlocked();
    return generateSessionRecoveryCodes(
      vaultKey,
      header,
      assertCurrent,
      (next) => this.#persistHeader(next, assertCurrent),
    );
  }

  /** The recovery codes and which are spent, or null when none were made. */
  async recoveryCodes() {
    const assertCurrent = this.#pinOperation();
    const { vaultKey, header } = this.#requireUnlocked();
    return readSessionRecoveryCodes(vaultKey, header, assertCurrent);
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
    const wasDecoy = storeRealm.endStoreRealm(this.#ownedSyntheticRealm);
    this.#discardSessionRoot();
    this.#writeChain = Promise.resolve();
    this.#pendingTotpSecret = null;
    this.#pendingCode = null;
    this.#pendingCodeAddress = null;
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
    discardTombCaches();
    if (guestBesideVault) {
      const back = guestHandBack(ephemeralTomb, wasDecoy, recordLastVault);
      this.#scope = back.scope;
      this.#header = back.header;
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

  isUnlocked(): boolean {
    return stateView.isVisibleStoreUnlocked(this.#scope.tomb, this.#vaultKey);
  }

  async changeMasterPassword(
    current: string,
    next: string,
    hint?: string,
  ): Promise<void> {
    const assertCurrent = this.#pinOperation();
    await changePasswordHeader(
      this.#scope.tomb,
      this.#header,
      current,
      next,
      hint,
      (header) => this.#persistHeader(header, assertCurrent),
    );
    assertCurrent();
  }

  // —— persistence ——————————————————————————————————————————

  async #persist(operation?: WriteOperation): Promise<void> {
    if (!this.#vaultKey) throw new Error("The vault is locked.");
    const assertCurrent = this.#pinOperation();
    const written = await writeBody(
      this.#scope.tomb,
      this.#vaultKey,
      this.#body,
      this.#header,
      operation,
    );
    assertCurrent();
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
    assertNotDecoySession();
    const assertCurrent = this.#pinOperation();
    const { vaultKey, header } = this.#requireUnlocked();
    await this.flushPendingWrites();
    assertCurrent();
    const port = this.#bodyPort();
    const merged = await mergeSnapshotInto(port, vaultKey, header, input);
    assertCurrent();
    // Another device's password change arrives in the body (`master-wrap.ts`).
    const adopted = this.#header && adoptedMasterWrap(this.#body, this.#header);
    if (adopted) await this.#persistHeader(adopted, assertCurrent);
    assertCurrent();
    return merged;
  }

  /** This vault's header and sealed body as stored, once pending writes land. */
  async sealedSnapshot(): Promise<SealedSnapshot> {
    assertNotDecoySession();
    const assertCurrent = this.#pinOperation();
    const { header } = this.#requireUnlocked();
    await this.flushPendingWrites();
    assertCurrent();
    const body = readSealedFile(this.#scope.tomb, BODY_PATH);
    if (!body) throw new Error("There is nothing stored to sync yet.");
    return { tomb: this.#scope.tomb, header, body, rev: this.#body.rev ?? 0 };
  }

  /** Apply a mutation and seal it, in the order requested (a rename per keystroke). */
  #mutate = (change: (body: VaultBody) => void): Promise<void> =>
    this.#exclusive((apply) => apply(stampedEdit(change)));

  /** Original-root serialization and shared-body locking live in store-exclusive. */
  #exclusive<T>(act: (apply: ApplyChange) => Promise<T>): Promise<T> {
    const run = queueExclusiveBodyWrite(
      this.#writeChain.then(() => undefined),
      this.#scope.tomb,
      this.#pinOperation(),
      {
        read: () => ({
          key: this.#vaultKey,
          header: this.#header,
          body: this.#body,
          mark: this.#sealMark,
          carries: sharesBody(this.#ephemeral, this.#scope.tomb),
        }),
        install: (fresh) => {
          this.#header = fresh.header;
          if (fresh.body) this.#body = fresh.body;
        },
        emit: () => this.#emit(),
        apply: (change) => this.#apply(change),
        raw: () => this.#requireRaw(),
      },
      act,
    );
    this.#writeChain = run.catch(() => undefined);
    return run;
  }

  async #apply(change: BodyEdit, operation?: WriteOperation): Promise<void> {
    if (!this.#vaultKey) throw new Error("The vault is locked.");
    await applyGuardedBodyChange(
      change,
      this.#pinOperation(),
      () => this.#body,
      (body) => {
        this.#body = body;
      },
      () => this.#persist(operation),
      (rollback) => {
        if (!rollback) this.touch();
        this.#emit();
      },
    );
  }

  // —— item types (ADR 0087) ————————————————————————————————

  /** Validate a definition, store it in the sealed body, and register it for this session. */
  async installItemTypeDefinition(text: string): Promise<InstallResult> {
    return itemTypes.installSessionItemType(this.#itemTypeHost(), text);
  }

  /** Drop a definition. Items of that type keep their values. */
  async uninstallItemTypeDefinition(id: string): Promise<boolean> {
    return itemTypes.uninstallSessionItemType(this.#itemTypeHost(), id);
  }

  #itemTypeHost(): itemTypes.ItemTypeHost {
    return itemTypes.bindSessionItemTypes(
      this.#pinOperation(),
      this.#mutate,
      () => this.#body.itemTypes,
    );
  }

  // —— items ————————————————————————————————————————————————

  saveItem(item: VaultItem, folder?: Folder, ceiling?: Check): Promise<void> {
    return writeSavedItems(this.#writes(ceiling), [item], folder);
  }

  saveItems(items: Items, folder?: Folder, ceiling?: Check): Promise<void> {
    return writeSavedItems(this.#writes(ceiling), items, folder);
  }

  #writes(ceiling?: Check): ItemWriteHost {
    return itemWriteHost(
      this.#scope.tomb,
      this.#body.items,
      this.#pinOperation(),
      ceiling,
      (change, operation) =>
        this.#exclusive(() => this.#apply(stampedEdit(change), operation)),
    );
  }

  async trashItem(id: string): Promise<void> {
    await this.#mutate((body) => trashItem(body, id));
  }

  async restoreItem(id: string): Promise<void> {
    await this.#mutate((body) => restoreItem(body, id));
  }

  async purgeItem(id: string): Promise<void> {
    await this.#mutate((body) => purgeItem(body, id));
  }

  async emptyTrash(): Promise<void> {
    await this.#mutate((body) => emptyTrash(body));
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
    return exportSealedVault(this.#header, this.#scope.tomb);
  }

  /** Import a sealed export with its password, its PIN, or an unwrapped key. */
  importSealed(
    fileText: string,
    secret: string | Uint8Array,
    options: ImportOptions = {},
  ): Promise<number> {
    assertNotDecoySession();
    return importSealedInto(this.#bodyPort(), fileText, secret, options);
  }

  #bodyPort(): VaultBodyPort {
    return makeGuardedBodyPort({
      assertCurrent: this.#pinOperation(),
      tomb: () => this.#scope.tomb,
      open: () => this.#vaultKey !== null,
      carries: () => sharesBody(this.#ephemeral, this.#scope.tomb),
      header: () => this.#header,
      body: () => this.#body,
      exclusive: (act) => this.#exclusive(act),
    });
  }

  /** Irreversibly remove the vault from this device. */
  async destroy(): Promise<void> {
    this.#pinOperation()();
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
      this.#header = readTombHeader(this.#scope.tomb);
      writeLastVaultId(this.#scope.tomb);
    } else {
      this.#header = null;
    }
    this.#emit();
    // Queued behind any write still in the air. Deleting straight away would let
    // a persist that had already sealed its body land afterwards and put the
    // vault — ciphertext, header and all — back on a device it was deleted from.
    const done = queueStoreDestruction(
      this.#writeChain.then(() => undefined),
      scope,
    );
    this.#writeChain = done;
    await done;
    this.#emit();
  }

  // —— preferences and auto-lock ————————————————————————————

  setPrefs(next: Partial<VaultPrefs>): void {
    this.#pinOperation()();
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
    this.#idleTimer = scheduleIdleLock(
      this.#vaultKey ? this.#prefs.autoLockMinutes * 60_000 : 0,
      () => Date.now() - this.#lastActivity,
      () => this.lock(),
      (timer) => {
        this.#idleTimer = timer;
      },
    );
  }
}

export const vaultStore = new VaultStore();

// The device identity host mints through this store's body (ADR 0160 §5).
installDeviceKeyCarrier(() => bodyPortOf(vaultStore));

installVaultSessionHooks(() => vaultStore.getSnapshot());

export { WrongPasswordError, VaultCorruptError };
