/**
 * Browser vault-store integration for root protection (swarm BROWSER).
 * Manifest projection on unlock, enroll candidate→commit, session cancel.
 */

import type {
  ProtectionRecord,
  RecoveryKeyProtectorRecord,
  RootProtectionManifest,
  VaultHeader,
} from "@opensesame/vault-core";
import { assertNotCanceled, assertSessionGeneration } from "./adapter.js";
import type { EnrollableKind, HeldWebauthnPrf } from "./browser-enroll.js";
import { projectProtection } from "./browser-projection.js";
import type { ExternalEnrollment } from "./enroll-external.js";
import { ProtectionError } from "./errors.js";
import {
  type GuardedProtectionHost,
  guardProtectionHost,
} from "./guarded-browser-host.js";
import { newOpaqueId } from "./ids.js";
import {
  type MutationJournal,
  assertExpectedRevision,
  beginMutationJournal,
} from "./lifecycle.js";
import {
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "./manifest-auth.js";
import { resolveProtectionManifest } from "./protection-view.js";
import type { ProofMaterial } from "./protector-proof.js";
import { contextForRecord } from "./record-context.js";
import { openWithRecoveryKey } from "./recovery-key.js";
import type { ProtectionSessionGuard } from "./session-guard.js";

export type ProtectionBrowserHost = {
  isGuestOrEphemeral(): boolean;
  getHeader(): VaultHeader | null;
  requireRawRoot(): Uint8Array;
  isUnlocked(): boolean;
  persistHeader(next: VaultHeader): Promise<void>;
  replaceRawVaultKey(next: Uint8Array, header: VaultHeader): Promise<void>;
  session: ProtectionSessionGuard;
  pinContext?(allowKeyAdmission?: boolean): () => void;
};

export type EnrollCandidateResult = {
  operationId: string;
  expectedRevision: number;
  sessionGeneration: number;
  record: ProtectionRecord;
  /** Shown-once recovery secret; never persisted by this service. */
  recoverySecretB64?: string;
  /** Shown-once age identity minted for a new recipient; never persisted. */
  ageIdentitySecret?: string;
};

type PendingEnrollment = {
  operationId: string;
  sessionGeneration: number;
  expectedRevision: number;
  journal: MutationJournal;
  record: ProtectionRecord;
  recoverySecretB64?: string;
  baseManifest: RootProtectionManifest;
};

function manifestAuthority(header: VaultHeader): RootProtectionManifest | null {
  return resolveProtectionManifest(header, header.protection);
}

export class VaultProtectionBrowserService {
  #host: ProtectionBrowserHost;
  #pending: PendingEnrollment | null = null;
  #projecting: Promise<void> = Promise.resolve();

  constructor(host: ProtectionBrowserHost) {
    this.#host = host;
  }

  listProtectors(): ProtectionRecord[] {
    const header = this.#host.getHeader();
    if (!header) return [];
    return manifestAuthority(header)?.records ?? [];
  }

  /** Drop pending enrollments and invalidate captured session generations. */
  cancelPendingOps(): void {
    this.#pending = null;
    this.#host.session.bump();
  }

  /**
   * KP-01/02: project legacy wraps into `header.protection` without rewriting
   * wrap bytes. Idempotent when protection is already present.
   */
  async ensureProtectionProjected(): Promise<void> {
    const host = guardProtectionHost(this.#host);
    const run = this.#projecting.then(() => projectProtection(host));
    this.#projecting = run.catch(() => undefined);
    return run;
  }

  /**
   * Account sign-in already created a PRF-capable passkey. Wrap the vault
   * root only when the person opts in — never from the ceremony itself.
   */
  async enrollHeldWebauthnPrf(
    input: HeldWebauthnPrf,
  ): Promise<EnrollCandidateResult> {
    return this.#stageEnrollment("webauthn-prf", input);
  }

  async enrollCandidate(
    kind: "recovery-key" | "age-webauthn" | "webauthn-prf",
  ): Promise<EnrollCandidateResult> {
    return this.#stageEnrollment(kind);
  }

  /**
   * An age recipient or a cloud KMS key: the record is built and opened again
   * before this returns, and reaches the manifest only through
   * `commitEnrollment`, like every other kind.
   */
  async enrollExternal(
    enrollment: ExternalEnrollment,
  ): Promise<EnrollCandidateResult> {
    return this.#stageEnrollment(enrollment.kind, undefined, enrollment);
  }

  async #stageEnrollment(
    kind: EnrollableKind,
    held?: HeldWebauthnPrf | undefined,
    external?: ExternalEnrollment | undefined,
  ): Promise<EnrollCandidateResult> {
    const host = guardProtectionHost(this.#host);
    this.#assertCanMutate();
    assertNotCanceled(this.#host.session.signal);
    await this.ensureProtectionProjected();
    await this.#assertManifestTrusted(host);
    const header = this.#requireHeader(host);
    const base = this.#requireManifest(header);
    const expectedRevision = base.revision;
    assertExpectedRevision(base, expectedRevision);
    const operationId = newOpaqueId("op");
    const sessionGeneration = this.#host.session.generation;
    const journal = beginMutationJournal({
      vaultId: base.vaultId,
      expectedRevision,
      operationId,
    });
    const { provenEnrollmentRecord } = await import("./browser-enroll.js");
    assertSessionGeneration(sessionGeneration, this.#host.session.generation);
    assertNotCanceled(this.#host.session.signal);
    this.#assertCanMutate();
    const built = await provenEnrollmentRecord({
      kind,
      base,
      rootKey: host.requireRawRoot(),
      operationId,
      sessionGeneration,
      signal: this.#host.session.signal,
      held,
      external,
    });
    assertSessionGeneration(sessionGeneration, this.#host.session.generation);
    assertNotCanceled(this.#host.session.signal);
    journal.phase = "proven";
    journal.candidateManifest = {
      ...base,
      revision: expectedRevision + 1,
      records: [...base.records, built.record],
    };
    const pending: PendingEnrollment = {
      operationId,
      sessionGeneration,
      expectedRevision,
      journal,
      record: built.record,
      baseManifest: base,
    };
    if (built.recoverySecretB64 !== undefined)
      pending.recoverySecretB64 = built.recoverySecretB64;
    this.#pending = pending;
    const result: EnrollCandidateResult = {
      operationId,
      expectedRevision,
      sessionGeneration,
      record: built.record,
    };
    if (built.recoverySecretB64 !== undefined)
      result.recoverySecretB64 = built.recoverySecretB64;
    if (built.ageIdentitySecret !== undefined)
      result.ageIdentitySecret = built.ageIdentitySecret;
    return result;
  }

  async commitEnrollment(operationId: string): Promise<void> {
    const host = guardProtectionHost(this.#host);
    this.#assertCanMutate();
    await this.#assertManifestTrusted(host);
    const pending = this.#pending;
    if (!pending || pending.operationId !== operationId) {
      throw new ProtectionError(
        "malformed_encoding",
        "No matching protection enrollment candidate is pending.",
      );
    }
    assertSessionGeneration(
      pending.sessionGeneration,
      this.#host.session.generation,
    );
    assertNotCanceled(this.#host.session.signal);

    const header = this.#requireHeader(host);
    const current = this.#requireManifest(header);
    assertExpectedRevision(current, pending.expectedRevision);

    const { authB64: _drop, ...rest } = current;
    const nextBody: Omit<RootProtectionManifest, "authB64"> = {
      ...rest,
      revision: pending.expectedRevision + 1,
      records: [...current.records, pending.record],
    };
    const sealed = await sealAuthenticatedManifest(
      host.requireRawRoot(),
      nextBody,
    );
    // Persist protection only — wrap / kdf / unlocks bytes stay untouched.
    await host.persistHeader({ ...header, protection: sealed });
    pending.journal.phase = "committed";
    this.#pending = null;
  }

  async setPreferred(protectorId: string): Promise<void> {
    const host = guardProtectionHost(this.#host);
    this.#assertCanMutate();
    await this.ensureProtectionProjected();
    await this.#assertManifestTrusted(host);
    const { setPreferredProtector } = await this.#mutationOps(host);
    await setPreferredProtector(host, protectorId);
    host.assertCurrent();
  }

  async removeProtector(protectorId: string): Promise<void> {
    const host = guardProtectionHost(this.#host);
    this.#assertCanMutate();
    await this.ensureProtectionProjected();
    await this.#assertManifestTrusted(host);
    const { removeProtector } = await this.#mutationOps(host);
    await removeProtector(host, protectorId);
    host.assertCurrent();
  }

  async testProtector(
    protectorId: string,
    material?: ProofMaterial,
  ): Promise<ProtectionRecord> {
    const host = guardProtectionHost(this.#host);
    this.#assertCanMutate();
    await this.ensureProtectionProjected();
    await this.#assertManifestTrusted(host);
    const { testProtector } = await this.#mutationOps(host);
    const record = await testProtector(host, protectorId, material);
    host.assertCurrent();
    return record;
  }

  async rotateCompromisedRoot(input: { password: string }): Promise<void> {
    const host = guardProtectionHost(this.#host, true);
    this.#assertCanMutate();
    await this.ensureProtectionProjected();
    await this.#assertManifestTrusted(host);
    const { rotateCompromisedRoot } = await this.#mutationOps(host);
    await rotateCompromisedRoot(host, input);
    host.assertCurrent();
  }

  /**
   * Open a recovery-key protector against the current vault's manifest.
   * Does not switch the unlocked session; callers compare or re-import.
   */
  async openRecoveryKey(secretB64: string): Promise<Uint8Array> {
    const host = guardProtectionHost(this.#host);
    const header = this.#requireHeader(host);
    const manifest = this.#requireManifest(header);
    const record = manifest.records.find(
      (entry): entry is RecoveryKeyProtectorRecord =>
        entry.kind === "recovery-key",
    );
    if (!record) {
      throw new ProtectionError(
        "unavailable",
        "No recovery-key protector is enrolled on this vault.",
      );
    }
    const root = await openWithRecoveryKey({
      context: contextForRecord(manifest, record.protectorId),
      record,
      secretB64,
    });
    try {
      host.assertCurrent();
      return root;
    } catch (error) {
      root.fill(0);
      throw error;
    }
  }

  /** Loading crypto must not let a request cross a lock or session change. */
  async #mutationOps(host: GuardedProtectionHost) {
    const operations = await import("./browser-lifecycle-ops.js");
    host.assertCurrent();
    assertNotCanceled(this.#host.session.signal);
    this.#assertCanMutate();
    return operations;
  }

  #assertCanMutate(): void {
    if (this.#host.isGuestOrEphemeral()) {
      throw new ProtectionError(
        "unavailable",
        "Guest sessions cannot enroll protectors into another vault.",
      );
    }
    if (!this.#host.isUnlocked()) {
      throw new ProtectionError(
        "unavailable",
        "Unlock the vault before changing protectors.",
      );
    }
  }

  async #assertManifestTrusted(
    host = guardProtectionHost(this.#host),
  ): Promise<void> {
    const header = host.getHeader();
    if (!header?.protection) return;
    await verifyManifestAuth(host.requireRawRoot(), header.protection);
    host.assertCurrent();
  }

  #requireHeader(host = this.#host): VaultHeader {
    const header = host.getHeader();
    if (!header) {
      throw new ProtectionError(
        "unavailable",
        "There is no vault header on this device.",
      );
    }
    return header;
  }

  #requireManifest(header: VaultHeader): RootProtectionManifest {
    const manifest = manifestAuthority(header);
    if (!manifest) {
      throw new ProtectionError(
        "unavailable",
        "Protection manifest is not available.",
      );
    }
    return manifest;
  }
}
