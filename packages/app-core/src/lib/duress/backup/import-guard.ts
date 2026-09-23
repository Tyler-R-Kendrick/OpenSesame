/**
 * Backup import / restore epoch gates and residual-key disclosure (BACKUP-D).
 */

export type AuthorityEpochs = Readonly<{
  incidentEpoch: number;
  policyRevision: number;
  keyEpoch: number;
}>;

export type OfflineSnapshot = Readonly<{
  version: 1;
  vaultRef: string;
  deviceBindingRef: string;
  capturedAt: string;
  /** Epochs at capture time — may be stale vs current authority. */
  epochs: AuthorityEpochs;
  /** Whether the snapshot still embeds a usable pre-rotation root. */
  embedsUsableOldRoot: boolean;
  ciphertextPresent: boolean;
}>;

export type ImportDecision =
  | {
      allowed: true;
      residualDecryptability: ResidualDisclosure;
    }
  | {
      allowed: false;
      code:
        | "stale_policy"
        | "stale_session"
        | "retired_device"
        | "recovery_required";
      residualDecryptability: ResidualDisclosure;
      reason: string;
    };

export type ResidualDisclosure = Readonly<{
  historicalCopyMayDecrypt: boolean;
  disclosure:
    | "old_offline_snapshot_plus_old_key_remains_decryptable"
    | "no_usable_old_root_disclosed";
  /** Root rotation is not retroactive secrecy (INV-24). */
  rootRotationIsRetroactiveSecrecy: false;
}>;

export function discloseResidualDecryptability(
  snapshot: Pick<OfflineSnapshot, "embedsUsableOldRoot" | "ciphertextPresent">,
): ResidualDisclosure {
  const historicalCopyMayDecrypt =
    snapshot.embedsUsableOldRoot && snapshot.ciphertextPresent;
  return {
    historicalCopyMayDecrypt,
    disclosure: historicalCopyMayDecrypt
      ? "old_offline_snapshot_plus_old_key_remains_decryptable"
      : "no_usable_old_root_disclosed",
    rootRotationIsRetroactiveSecrecy: false,
  };
}

/**
 * Importing an old backup into a current authority-governed context must not
 * lower epochs, clear incidents, or silently authorize a retired device.
 */
export function validateBackupImport(input: {
  snapshot: OfflineSnapshot;
  current: AuthorityEpochs;
  deviceRetired: boolean;
  /** Explicit recovery/re-enroll authorization for this binding. */
  recoveryAuthorized?: boolean;
}): ImportDecision {
  const residual = discloseResidualDecryptability(input.snapshot);

  if (input.deviceRetired && !input.recoveryAuthorized) {
    return {
      allowed: false,
      code: "retired_device",
      residualDecryptability: residual,
      reason:
        "Cannot import snapshot onto a retired device binding without recovery or re-enrollment.",
    };
  }

  if (input.snapshot.epochs.policyRevision > input.current.policyRevision) {
    // Future-dated relative to current is suspicious; refuse.
    return {
      allowed: false,
      code: "stale_policy",
      residualDecryptability: residual,
      reason: "Snapshot policy revision is ahead of current authority.",
    };
  }

  if (input.snapshot.epochs.policyRevision < input.current.policyRevision) {
    return {
      allowed: false,
      code: "stale_policy",
      residualDecryptability: residual,
      reason:
        "Snapshot policy revision is stale; import cannot lower or ignore current policy.",
    };
  }

  if (input.snapshot.epochs.keyEpoch < input.current.keyEpoch) {
    return {
      allowed: false,
      code: "stale_session",
      residualDecryptability: residual,
      reason:
        "Snapshot key epoch is behind current; residual old-key decryptability is disclosed, not authorized as current authority.",
    };
  }

  if (input.snapshot.epochs.incidentEpoch < input.current.incidentEpoch) {
    return {
      allowed: false,
      code: "stale_session",
      residualDecryptability: residual,
      reason:
        "Snapshot predates current incident epoch; cannot clear or rewind incident fence via import.",
    };
  }

  return {
    allowed: true,
    residualDecryptability: residual,
  };
}

/**
 * Malicious restore: attempt to force-apply snapshot epochs below current.
 * Always refuse; never mutate current epochs from snapshot alone.
 */
export type EpochDowngradeRefusal = Readonly<{
  ok: false;
  code: "stale_session";
  current: AuthorityEpochs;
}>;

export function refuseMaliciousEpochDowngrade(input: {
  proposed: AuthorityEpochs;
  current: AuthorityEpochs;
}): EpochDowngradeRefusal {
  void input.proposed;
  // Snapshot alone never becomes the authority clock (malicious restore).
  return {
    ok: false,
    code: "stale_session",
    current: input.current,
  } satisfies EpochDowngradeRefusal;
}
