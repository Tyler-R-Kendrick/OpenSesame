/**
 * Browser vault-store integration for root protection (swarm BROWSER).
 * Manifest projection on unlock, enroll candidate→commit, session cancel.
 */

import type { VaultHeader } from "../crypto.js";
import {
  assertNotCanceled,
  assertSessionGeneration,
  mintRootKeyHandle,
} from "./adapter.js";
import { enrollAgeWebauthn } from "./adapters/age-webauthn.js";
import { protectorFromPrfMaterial } from "./adapters/webauthn-prf-ops.js";
import { createWebauthnPrfProtector } from "./adapters/webauthn-prf.js";
import {
  removeProtector as removeProtectorOp,
  rotateCompromisedRoot as rotateCompromisedRootOp,
  setPreferredProtector as setPreferredProtectorOp,
  testProtector as testProtectorOp,
} from "./browser-lifecycle-ops.js";
import { ProtectionError } from "./errors.js";
import { newOpaqueId, newProtectorId } from "./ids.js";
import {
  type MutationJournal,
  assertExpectedRevision,
  beginMutationJournal,
} from "./lifecycle.js";
import {
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "./manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "./migrate-legacy.js";
import { resolveProtectionManifest } from "./protection-view.js";
import { enrollRecoveryKey, openWithRecoveryKey } from "./recovery-key.js";
import type { ProtectionSessionGuard } from "./session-guard.js";
import type {
  ProtectionContext,
  ProtectionRecord,
  RecoveryKeyProtectorRecord,
  RootProtectionManifest,
} from "./types.js";

export type ProtectionBrowserHost = {
  isGuestOrEphemeral(): boolean;
  getHeader(): VaultHeader | null;
  requireRawRoot(): Uint8Array;
  isUnlocked(): boolean;
  persistHeader(next: VaultHeader): Promise<void>;
  replaceRawVaultKey(next: Uint8Array): Promise<void>;
  session: ProtectionSessionGuard;
};

export type EnrollCandidateResult = {
  operationId: string;
  expectedRevision: number;
  sessionGeneration: number;
  record: ProtectionRecord;
  /** Shown-once recovery secret; never persisted by this service. */
  recoverySecretB64?: string;
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

function contextForRecord(
  manifest: RootProtectionManifest,
  protectorId: string,
): ProtectionContext {
  return {
    vaultId: manifest.vaultId,
    rootKeyId: manifest.rootKeyId,
    rootEpoch: manifest.rootEpoch,
    protectorId,
    purpose: manifest.purpose,
  };
}

function manifestAuthority(header: VaultHeader): RootProtectionManifest | null {
  return resolveProtectionManifest(header, header.protection);
}

function rootsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export class VaultProtectionBrowserService {
  #host: ProtectionBrowserHost;
  #pending: PendingEnrollment | null = null;

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
    const header = this.#host.getHeader();
    if (!header || !this.#host.isUnlocked()) return;
    if (header.protection) return;
    const raw = this.#host.requireRawRoot();
    const { manifest } = migrateLegacyHeaderToManifest({ header });
    const sealed = await sealAuthenticatedManifest(raw, manifest);
    await this.#host.persistHeader({ ...header, protection: sealed });
  }

  /**
   * Account sign-in already created a PRF-capable passkey. Wrap the vault
   * root only when the person opts in — never from the ceremony itself.
   */
  async enrollHeldWebauthnPrf(input: {
    prfOutput: ArrayBuffer;
    prfSalt: Uint8Array;
    credentialId: ArrayBuffer;
    userId: ArrayBuffer;
  }): Promise<EnrollCandidateResult> {
    this.#assertCanMutate();
    assertNotCanceled(this.#host.session.signal);
    await this.ensureProtectionProjected();
    await this.#assertManifestTrusted();
    const header = this.#requireHeader();
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
    const rootKey = this.#host.requireRawRoot();
    const provenRecord = await protectorFromPrfMaterial({
      rootKey,
      prfOutput: input.prfOutput,
      prfSalt: input.prfSalt,
      credentialId: input.credentialId,
      userId: input.userId,
      protectorId: newProtectorId("webauthn-prf"),
    });
    journal.phase = "proven";
    journal.candidateManifest = {
      ...base,
      revision: expectedRevision + 1,
      records: [...base.records, provenRecord],
    };
    this.#pending = {
      operationId,
      sessionGeneration,
      expectedRevision,
      journal,
      record: provenRecord,
      baseManifest: base,
    };
    return {
      operationId,
      expectedRevision,
      sessionGeneration,
      record: provenRecord,
    };
  }

  async enrollCandidate(
    kind: "recovery-key" | "age-webauthn" | "webauthn-prf",
  ): Promise<EnrollCandidateResult> {
    this.#assertCanMutate();
    assertNotCanceled(this.#host.session.signal);
    await this.ensureProtectionProjected();
    await this.#assertManifestTrusted();
    const header = this.#requireHeader();
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

    const rootKey = this.#host.requireRawRoot();
    let provenRecord: ProtectionRecord;
    let recoverySecretB64: string | undefined;

    if (kind === "recovery-key") {
      const proven = await enrollRecoveryKey({
        context: contextForRecord(base, base.vaultId),
        rootKey,
      });
      const opened = await openWithRecoveryKey({
        context: contextForRecord(base, proven.record.protectorId),
        record: proven.record,
        secretB64: proven.secretB64,
      });
      try {
        if (!rootsEqual(opened, rootKey)) {
          throw new ProtectionError(
            "enrollment_proof_failed",
            "Recovery-key enrollment recovered a different root key.",
          );
        }
      } finally {
        opened.fill(0);
      }
      provenRecord = proven.record;
      recoverySecretB64 = proven.secretB64;
    } else if (kind === "age-webauthn") {
      const enrolled = await enrollAgeWebauthn({
        context: contextForRecord(base, base.vaultId),
        rootKey,
      });
      provenRecord = enrolled.record;
    } else if (kind === "webauthn-prf") {
      const protectorId = newProtectorId("webauthn-prf");
      const context = contextForRecord(base, protectorId);
      const pending = await createWebauthnPrfProtector({
        sessionGeneration,
      }).enroll({
        operationId,
        sessionGeneration,
        context,
        rootHandle: mintRootKeyHandle(context, rootKey),
        signal: this.#host.session.signal,
      });
      provenRecord = pending.record;
    } else {
      throw new ProtectionError(
        "unsupported_runtime",
        `Protector kind ${String(kind)} is not enrolled by this service.`,
      );
    }

    journal.phase = "proven";
    journal.candidateManifest = {
      ...base,
      revision: expectedRevision + 1,
      records: [...base.records, provenRecord],
    };

    const pending: PendingEnrollment = {
      operationId,
      sessionGeneration,
      expectedRevision,
      journal,
      record: provenRecord,
      baseManifest: base,
    };
    if (recoverySecretB64 !== undefined) {
      pending.recoverySecretB64 = recoverySecretB64;
    }
    this.#pending = pending;

    const result: EnrollCandidateResult = {
      operationId,
      expectedRevision,
      sessionGeneration,
      record: provenRecord,
    };
    if (recoverySecretB64 !== undefined) {
      result.recoverySecretB64 = recoverySecretB64;
    }
    return result;
  }

  async commitEnrollment(operationId: string): Promise<void> {
    this.#assertCanMutate();
    await this.#assertManifestTrusted();
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

    const { authB64: _drop, ...rest } = current;
    const nextBody: Omit<RootProtectionManifest, "authB64"> = {
      ...rest,
      revision: pending.expectedRevision + 1,
      records: [...current.records, pending.record],
    };
    const sealed = await sealAuthenticatedManifest(
      this.#host.requireRawRoot(),
      nextBody,
    );
    // Persist protection only — wrap / kdf / unlocks bytes stay untouched.
    await this.#host.persistHeader({ ...header, protection: sealed });
    pending.journal.phase = "committed";
    this.#pending = null;
  }

  async setPreferred(protectorId: string): Promise<void> {
    this.#assertCanMutate();
    await this.ensureProtectionProjected();
    await this.#assertManifestTrusted();
    await setPreferredProtectorOp(this.#host, protectorId);
  }

  async removeProtector(protectorId: string): Promise<void> {
    this.#assertCanMutate();
    await this.ensureProtectionProjected();
    await this.#assertManifestTrusted();
    await removeProtectorOp(this.#host, protectorId);
  }

  async testProtector(
    protectorId: string,
    material?: { recoverySecretB64?: string },
  ): Promise<ProtectionRecord> {
    this.#assertCanMutate();
    await this.ensureProtectionProjected();
    await this.#assertManifestTrusted();
    return testProtectorOp(this.#host, protectorId, material);
  }

  async rotateCompromisedRoot(input: { password: string }): Promise<void> {
    this.#assertCanMutate();
    await this.ensureProtectionProjected();
    await this.#assertManifestTrusted();
    await rotateCompromisedRootOp(this.#host, input);
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
