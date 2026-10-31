/** Original unlock lifetime and custody only; authentication stays with each configured factor. */
import { type VaultBody, WrongPasswordError } from "@opensesame/vault-core";
import { noteVaultUnlocked } from "../activity-log.js";
import { recordDeadmanAuthentication } from "../deadman/state.js";
import { kvDelete } from "../kv.js";
import { writeLastVaultId } from "../last-vault.js";
import {
  type LocalIamAccess,
  createTrustedUnlockAccess,
} from "../local-iam-access.js";
import {
  type TrustedUnlockPolicy,
  type TrustedUnlockView,
  readTrustedUnlock,
  trustedUnlockSeams,
  trustedUnlockView,
} from "../trusted-unlock.js";
import { unlockTomb } from "../vfs.js";
import type { VaultProtectionBrowserService } from "./protection/browser-service.js";
import { rebindTombSeals } from "./seal-rebind.js";
import { PendingChallenge } from "./second-step-guard.js";
import { type VaultBodyPort, levelDeviceKey } from "./store-device-key.js";
import { sealMark } from "./store-fresh.js";
import type { captureStoreOperation } from "./store-operation-check.js";
import type { StorePreferences } from "./store-preferences.js";
import type { VaultScope } from "./store-scope.js";
import { hydrateAndMigrateTombOnUnlock } from "./tomb-migration.js";

type Lease = { tomb: string; release: () => Promise<void> };
export type UnlockAttempt = Readonly<{
  scope: VaultScope;
  check: () => void;
  session: () => void;
  closeOriginal: (close: () => void) => void;
}> & { lease: Lease | null };
type UnlockHost = Readonly<{
  scope: () => VaultScope;
  original: () => Pick<
    ReturnType<typeof captureStoreOperation>,
    "context" | "closeOriginal"
  >;
  close: () => void;
  frozen: () => void;
  clearPending: () => void;
  setKey: (key: CryptoKey) => void;
  loadBody: (tomb: string, key: CryptoKey) => Promise<VaultBody>;
  setBody: (body: VaultBody, mark: string | null) => void;
  bodyPort: () => VaultBodyPort;
  preferences: StorePreferences;
  protection: () => VaultProtectionBrowserService;
  acquire: (tomb: string) => Promise<Lease | null>;
  commit: (lease: Lease | null) => void;
  emit: () => void;
  completed: () => void;
}>;
type TrustedChallenge = {
  key: CryptoKey;
  access: LocalIamAccess;
  policy: TrustedUnlockPolicy;
  approved: Set<string>;
  view: TrustedUnlockView | null;
};

export class StoreUnlockSession {
  #host: UnlockHost;
  #current: UnlockAttempt | null = null;
  #activating = new WeakSet<UnlockAttempt>();
  #retained = new WeakSet<UnlockAttempt>();
  #checkingTrust = new WeakSet<UnlockAttempt>();
  #trusted: TrustedChallenge | null = null;
  #trustedAccess: ReturnType<typeof createTrustedUnlockAccess> | null = null;
  #timer = new PendingChallenge();

  constructor(host: UnlockHost) {
    this.#host = host;
  }

  get trustedKey(): CryptoKey | null {
    return this.#trusted?.key ?? null;
  }
  get trustedView(): TrustedUnlockView | null {
    return this.#trusted?.view ?? null;
  }

  #stale(): never {
    throw new WrongPasswordError("That second step is no longer pending.");
  }

  begin(): UnlockAttempt {
    this.cancel();
    const scope = this.#host.scope();
    const operation = this.#host.original();
    const attempt: UnlockAttempt = {
      scope,
      session: operation.context,
      closeOriginal: operation.closeOriginal,
      lease: null,
      check: () => {
        if (this.#current !== attempt) this.#stale();
        operation.context();
      },
    };
    this.#current = attempt;
    return attempt;
  }

  current(): UnlockAttempt {
    if (!this.#current) this.#stale();
    this.#current.check();
    return this.#current;
  }

  /** A failed primary owns no root and must not emit an explicit vault lock on retry. */
  retainPrimary(attempt: UnlockAttempt): void {
    attempt.check();
    this.#retained.add(attempt);
  }

  async #release(attempt: UnlockAttempt): Promise<void> {
    const lease = attempt.lease;
    attempt.lease = null;
    if (lease) await lease.release().catch(() => undefined);
  }

  /** Lock uses this synchronously, before any later completion can publish. */
  reset(): void {
    const attempt = this.#current;
    this.#current = null;
    this.#trusted = null;
    this.#revokeTrustedAccess();
    this.#timer.clear();
    if (attempt) void this.#release(attempt);
  }

  #revokeTrustedAccess(): void {
    const access = this.#trustedAccess;
    this.#trustedAccess = null;
    access?.revoke();
  }

  cancel(): void {
    const attempt = this.#current;
    if (!attempt) return;
    if (this.#retained.has(attempt)) attempt.closeOriginal(this.#host.close);
    if (this.#current === attempt) this.reset();
  }

  cancelTrusted(): void {
    if (this.#trusted) this.cancel();
  }

  arm(attempt: UnlockAttempt): void {
    attempt.check();
    this.#timer.arm(() => {
      if (this.#current === attempt) this.cancel();
    });
  }

  async #failed(attempt: UnlockAttempt): Promise<void> {
    // A stale owner may release its own lease, never the current session's state.
    if (this.#current === attempt && this.#host.scope() === attempt.scope) {
      attempt.closeOriginal(this.#host.close);
    }
    await this.#release(attempt);
  }

  async requireTrusted(key: CryptoKey, attempt: UnlockAttempt): Promise<void> {
    attempt.check();
    if (this.#checkingTrust.has(attempt)) this.#stale();
    this.#checkingTrust.add(attempt);
    this.#host.clearPending();
    this.#trustedAccess = createTrustedUnlockAccess(
      attempt.scope.tomb,
      key,
      attempt.check,
    );
    const { access } = this.#trustedAccess;
    try {
      const policy = await readTrustedUnlock(attempt.scope.tomb, access);
      attempt.check();
      if (!policy) return await this.activate(key, attempt);
      const challenge: TrustedChallenge = {
        key,
        access,
        policy,
        approved: new Set(),
        view: null,
      };
      this.#trusted = challenge;
      const view = await trustedUnlockView(
        attempt.scope.tomb,
        policy,
        [],
        access,
      );
      attempt.check();
      if (this.#trusted !== challenge) this.#stale();
      challenge.view = view;
      this.#timer.clear();
      this.#host.emit();
    } catch (error) {
      await this.#failed(attempt);
      throw error;
    }
  }

  async confirmTrusted(principalId: string): Promise<void> {
    const challenge = this.#trusted;
    if (!challenge) throw new Error("No trusted-contact approval is waiting.");
    const attempt = this.current();
    if (!challenge.policy.memberIds.includes(principalId))
      throw new Error("That identity is not a member of this circle.");
    if (challenge.approved.has(principalId)) return;
    await trustedUnlockSeams.authenticate(
      attempt.scope.tomb,
      principalId,
      challenge.access,
    );
    attempt.check();
    if (this.#trusted !== challenge)
      throw new Error("The trusted-contact challenge changed.");
    challenge.approved.add(principalId);
    const approved = [...challenge.approved];
    if (approved.length >= challenge.policy.threshold)
      return this.activate(challenge.key, attempt);
    const view = await trustedUnlockView(
      attempt.scope.tomb,
      challenge.policy,
      approved,
      challenge.access,
    );
    attempt.check();
    challenge.view = view;
    this.#host.emit();
  }

  #bodyPort(attempt: UnlockAttempt): VaultBodyPort {
    const port = this.#host.bodyPort();
    const held = <T>(read: () => T): T => {
      attempt.check();
      return read();
    };
    return {
      tomb: () => held(port.tomb),
      open: () => held(port.open),
      carries: () => held(port.carries),
      header: () => held(port.header),
      body: () => held(port.body),
      mutate: (change) =>
        held(() => port.mutate((body) => held(() => change(body)))),
      publishKey: (field) => held(() => port.publishKey(field)),
    };
  }

  async activate(key: CryptoKey, attempt = this.begin()): Promise<void> {
    attempt.check();
    if (this.#activating.has(attempt)) this.#stale();
    this.#activating.add(attempt);
    this.#retained.add(attempt);
    const { tomb, attempts } = attempt.scope;
    try {
      this.#host.frozen();
      // Store the returned resource before checking: cancel may win acquisition.
      attempt.lease = await this.#host.acquire(tomb);
      attempt.check();
      this.#revokeTrustedAccess();
      this.#host.setKey(key);
      this.#host.clearPending();
      unlockTomb(tomb, key);
      await rebindTombSeals(tomb, key, attempt.check);
      attempt.check();
      await hydrateAndMigrateTombOnUnlock(tomb, attempt.check);
      attempt.check();
      await this.#host.preferences.load(() => tomb, attempt.check);
      attempt.check();
      const body = await this.#host.loadBody(tomb, key);
      attempt.check();
      this.#host.setBody(body, sealMark(tomb));
      await levelDeviceKey(this.#bodyPort(attempt), { check: attempt.check });
      attempt.check();
      await this.#host.protection().ensureProtectionProjected();
      attempt.check();
      kvDelete(attempts);
      writeLastVaultId(tomb);
      this.#host.commit(attempt.lease);
      attempt.lease = null;
      this.#current = null;
      this.#trusted = null;
      this.#timer.clear();
      this.#host.completed();
      noteVaultUnlocked();
      await recordDeadmanAuthentication(tomb, attempt.session);
    } catch (error) {
      await this.#failed(attempt);
      throw error;
    }
  }
}
