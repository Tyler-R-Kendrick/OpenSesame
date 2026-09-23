import { mintRootKeyHandle } from "./adapter.js";
import { enrollAgeWebauthn } from "./adapters/age-webauthn.js";
import { protectorFromPrfMaterial } from "./adapters/webauthn-prf-ops.js";
import { createWebauthnPrfProtector } from "./adapters/webauthn-prf.js";
import { ProtectionError } from "./errors.js";
import { newProtectorId } from "./ids.js";
import { enrollRecoveryKey, openWithRecoveryKey } from "./recovery-key.js";
import type {
  ProtectionContext,
  ProtectionRecord,
  RootProtectionManifest,
} from "./types.js";

export function contextForRecord(
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

function rootsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export type HeldWebauthnPrf = {
  prfOutput: ArrayBuffer;
  prfSalt: Uint8Array;
  credentialId: ArrayBuffer;
  userId: ArrayBuffer;
};

/** Build a proven protector record. Does not touch the mutation journal. */
export async function provenEnrollmentRecord(input: {
  kind: "recovery-key" | "age-webauthn" | "webauthn-prf";
  base: RootProtectionManifest;
  rootKey: Uint8Array;
  operationId: string;
  sessionGeneration: number;
  signal: AbortSignal;
  held?: HeldWebauthnPrf | undefined;
}): Promise<{ record: ProtectionRecord; recoverySecretB64?: string }> {
  if (input.held) {
    return {
      record: await protectorFromPrfMaterial({
        rootKey: input.rootKey,
        prfOutput: input.held.prfOutput,
        prfSalt: input.held.prfSalt,
        credentialId: input.held.credentialId,
        userId: input.held.userId,
        protectorId: newProtectorId("webauthn-prf"),
      }),
    };
  }
  if (input.kind === "recovery-key") {
    const proven = await enrollRecoveryKey({
      context: contextForRecord(input.base, input.base.vaultId),
      rootKey: input.rootKey,
    });
    const opened = await openWithRecoveryKey({
      context: contextForRecord(input.base, proven.record.protectorId),
      record: proven.record,
      secretB64: proven.secretB64,
    });
    try {
      if (!rootsEqual(opened, input.rootKey)) {
        throw new ProtectionError(
          "enrollment_proof_failed",
          "Recovery-key enrollment recovered a different root key.",
        );
      }
    } finally {
      opened.fill(0);
    }
    return { record: proven.record, recoverySecretB64: proven.secretB64 };
  }
  if (input.kind === "age-webauthn") {
    const enrolled = await enrollAgeWebauthn({
      context: contextForRecord(input.base, input.base.vaultId),
      rootKey: input.rootKey,
    });
    return { record: enrolled.record };
  }
  if (input.kind === "webauthn-prf") {
    const protectorId = newProtectorId("webauthn-prf");
    const context = contextForRecord(input.base, protectorId);
    const pending = await createWebauthnPrfProtector({
      sessionGeneration: input.sessionGeneration,
    }).enroll({
      operationId: input.operationId,
      sessionGeneration: input.sessionGeneration,
      context,
      rootHandle: mintRootKeyHandle(context, input.rootKey),
      signal: input.signal,
    });
    return { record: pending.record };
  }
  throw new ProtectionError(
    "unsupported_runtime",
    `Protector kind ${String(input.kind)} is not enrolled by this service.`,
  );
}
