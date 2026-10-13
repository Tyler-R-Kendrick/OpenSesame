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
import type { LifecycleHost, RotationKey } from "./browser-lifecycle-ops.js";
import {
  type EnrollCandidateResult,
  type LifecycleOperation,
  type PendingEnrollment,
  committedEnrollmentBody,
  reconciledProjection,
  stageEnrollmentData,
} from "./browser-operation-data.js";
export type { EnrollCandidateResult } from "./browser-operation-data.js";
import {
  type ProtectionBrowserHost,
  captureBrowserOperation,
} from "./browser-operation-check.js";
export type { ProtectionBrowserHost } from "./browser-operation-check.js";
import type { ExternalEnrollment } from "./enroll-external.js";
import { ProtectionError } from "./errors.js";
import { newOpaqueId } from "./ids.js";
import { assertExpectedRevision, beginMutationJournal } from "./lifecycle.js";
import {
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "./manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "./migrate-legacy.js";
import { resolveProtectionManifest } from "./protection-view.js";
import { contextForRecord } from "./protector-context.js";
import type { ProofMaterial } from "./protector-proof.js";
import { openWithRecoveryKey } from "./recovery-key.js";

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
    const pinned = this.#host.isUnlocked()
      ? this.#operationHost("projection-queued")
      : null;
    const run = this.#projecting.then(() => this.#project(pinned));
    this.#projecting = run.catch(() => undefined);
    return run;
  }

  async #project(
    queued: (LifecycleHost & { check: () => void }) | null,
  ): Promise<void> {
    if (!queued) return;
    queued.check();
    const pinned = this.#operationHost("projection");
    const header = pinned.getHeader();
    if (!header) return;
    const raw = pinned.requireRawRoot();
    if (!header.protection) {
      const { manifest } = migrateLegacyHeaderToManifest({ header });
      const sealed = await sealAuthenticatedManifest(raw, manifest);
      await pinned.persistHeader({ ...header, protection: sealed });
      return;
    }
    // Password, PIN and passkey change under Unlock methods, which knows
    // nothing of the manifest: bring its copy of those wraps back in step. A
    // manifest that does not verify is left for the operation that acts on it
    // to report — housekeeping must not stand between a person and unlock.
    try {
      await verifyManifestAuth(raw, header.protection);
      pinned.check();
    } catch {
      pinned.check();
      return;
    }
    const body = reconciledProjection(header, header.protection);
    if (!body) return;
    await pinned.persistHeader({
      ...header,
      protection: await sealAuthenticatedManifest(raw, body),
    });
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
    this.#assertCanMutate();
    const sessionGeneration = this.#host.session.generation;
    const signal = this.#host.session.signal;
    assertNotCanceled(signal);
    await this.ensureProtectionProjected();
    this.#assertOperation(sessionGeneration, signal);
    await this.#assertManifestTrusted();
    this.#assertOperation(sessionGeneration, signal);
    const header = this.#requireHeader();
    const base = this.#requireManifest(header);
    const expectedRevision = base.revision;
    assertExpectedRevision(base, expectedRevision);
    const operationId = newOpaqueId("op");
    const journal = beginMutationJournal({
      vaultId: base.vaultId,
      expectedRevision,
      operationId,
    });
    const request = {
      kind,
      base,
      rootKey: this.#host.requireRawRoot(),
      operationId,
      sessionGeneration,
      signal,
      held,
      external,
    };
    const { provenEnrollmentRecord } = await import("./browser-enroll.js");
    this.#assertOperation(sessionGeneration, signal);
    await this.#assertManifestTrusted();
    this.#assertOperation(sessionGeneration, signal);
    assertExpectedRevision(
      this.#requireManifest(this.#requireHeader()),
      expectedRevision,
    );
    const built = await provenEnrollmentRecord(request);
    assertSessionGeneration(sessionGeneration, this.#host.session.generation);
    assertNotCanceled(this.#host.session.signal);
    const staged = stageEnrollmentData({
      base,
      journal,
      operationId,
      sessionGeneration,
      expectedRevision,
      built,
    });
    this.#pending = staged.pending;
    return staged.result;
  }

  async commitEnrollment(operationId: string): Promise<void> {
    const pinned = this.#operationHost();
    await this.#assertManifestTrusted();
    pinned.check();
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

    const header = this.#requireHeader();
    const current = this.#requireManifest(header);
    assertExpectedRevision(current, pending.expectedRevision);

    const nextBody = committedEnrollmentBody(current, pending);
    const sealed = await sealAuthenticatedManifest(
      pinned.requireRawRoot(),
      nextBody,
    );
    // Persist protection only — wrap / kdf / unlocks bytes stay untouched.
    await pinned.persistHeader({ ...header, protection: sealed });
    pinned.check();
    pending.journal.phase = "committed";
    this.#pending = null;
  }

  async setPreferred(protectorId: string): Promise<void> {
    await this.#lifecycle((operations, pinned) =>
      operations.setPreferredProtector(pinned, protectorId),
    );
  }

  async removeProtector(protectorId: string): Promise<void> {
    await this.#lifecycle((operations, pinned) =>
      operations.removeProtector(pinned, protectorId),
    );
  }

  async testProtector(
    protectorId: string,
    material?: ProofMaterial,
  ): Promise<ProtectionRecord> {
    return this.#lifecycle((operations, pinned) =>
      operations.testProtector(pinned, protectorId, material),
    );
  }

  async rotateCompromisedRoot(input: RotationKey): Promise<void> {
    await this.#lifecycle((operations, pinned) =>
      operations.rotateCompromisedRoot(pinned, input),
    );
  }

  /**
   * Open a recovery-key protector against the current vault's manifest.
   * Does not switch the unlocked session; callers compare or re-import.
   */
  async openRecoveryKey(secretB64: string): Promise<Uint8Array> {
    const header = this.#requireHeader();
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
    return openWithRecoveryKey({
      context: contextForRecord(manifest, record.protectorId),
      record,
      secretB64,
    });
  }

  #assertOperation(generation: number, signal: AbortSignal): void {
    assertSessionGeneration(generation, this.#host.session.generation);
    assertNotCanceled(signal);
    this.#assertCanMutate();
  }

  async #lifecycle<T>(run: LifecycleOperation<T>): Promise<T> {
    const preflight = this.#operationHost("projection-queued");
    await this.ensureProtectionProjected();
    preflight.check();
    const pinned = this.#operationHost();
    await this.#assertManifestTrusted();
    pinned.check();
    const operations = await import("./browser-lifecycle-ops.js");
    pinned.check();
    await this.#assertManifestTrusted();
    pinned.check();
    return run(operations, pinned);
  }

  /** Cancellation-only original host; never leaves lexical operation callers. */
  #operationHost(
    purpose: "mutation" | "projection" | "projection-queued" = "mutation",
  ) {
    return captureBrowserOperation(
      this.#host,
      () => this.#host,
      () => this.#assertCanMutate(),
      purpose,
    );
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

  async #assertManifestTrusted(): Promise<void> {
    const header = this.#host.getHeader();
    if (!header?.protection) return;
    await verifyManifestAuth(this.#host.requireRawRoot(), header.protection);
  }

  #requireHeader(): VaultHeader {
    const header = this.#host.getHeader();
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
