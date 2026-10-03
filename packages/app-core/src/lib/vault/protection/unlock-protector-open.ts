/**
 * Open the vault root from an enrolled protector, before anything is unlocked.
 *
 * This is the open that `protector-proof.ts` proves from Settings — the same
 * capsule openers (`openWithRecoveryKey`, `openAgeCapsule`, `openAgeWebauthn`)
 * with the same context binding — fed from the header instead of from an
 * unlocked session. It returns the raw root; the store's unlock path turns it
 * into a session exactly as it does for a password.
 *
 * Every refusal that is about the material — nothing enrolled, a key that does
 * not open any capsule, text that is not a key at all — ends the same way, as
 * one `WrongPasswordError`, so the screen cannot tell a person (or whoever is
 * holding the device) which of those it was. A person who dismisses a prompt
 * is not a failed attempt and is rethrown untouched.
 */

import {
  type ProtectionContext,
  type ProtectionRecord,
  type RootProtectionManifest,
  type VaultHeader,
  WrongPasswordError,
} from "@opensesame/vault-core";
import { isAgeIdentity } from "../../age-keys.js";
import { openAgeCapsule } from "./adapters/age-recipient.js";
import {
  type AgeWebauthnCrypto,
  openAgeWebauthn,
} from "./adapters/age-webauthn.js";
import { ProtectionError } from "./errors.js";
import { openWithRecoveryKey } from "./recovery-key.js";
import {
  type ProtectorUnlockMethodId,
  capsuleRecordsFor,
} from "./unlock-protector-methods.js";

export type ProtectorUnlockInput = Readonly<{
  method: ProtectorUnlockMethodId;
  /** The recovery key or age identity the person typed; held for the call only. */
  secret?: string;
  signal?: AbortSignal;
  /** Test seam for the age passkey ceremony; the real one runs when absent. */
  ageWebauthnCrypto?: AgeWebauthnCrypto;
}>;

export const UNLOCK_RECOVERY_MISS =
  "That recovery key did not unlock the vault.";
export const UNLOCK_AGE_MISS = "That age key did not unlock the vault.";
export const UNLOCK_AGE_PASSKEY_MISS = "That passkey did not unlock the vault.";

export function protectorUnlockMiss(method: ProtectorUnlockMethodId): string {
  switch (method) {
    case "recovery":
      return UNLOCK_RECOVERY_MISS;
    case "age":
      return UNLOCK_AGE_MISS;
    default:
      return UNLOCK_AGE_PASSKEY_MISS;
  }
}

function contextFor(
  manifest: RootProtectionManifest,
  record: ProtectionRecord,
): ProtectionContext {
  return {
    vaultId: manifest.vaultId,
    rootKeyId: manifest.rootKeyId,
    rootEpoch: manifest.rootEpoch,
    protectorId: record.protectorId,
    purpose: manifest.purpose,
  };
}

/** A prompt the person dismissed, or work a lock or a new attempt cancelled. */
export function isUncountedProtectorFailure<Thrown>(error: Thrown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return (
    error instanceof ProtectionError &&
    (error.code === "canceled" ||
      error.code === "stale_operation" ||
      error.code === "unsupported_runtime")
  );
}

type Opener = (
  record: ProtectionRecord,
  context: ProtectionContext,
) => Promise<Uint8Array>;

function openerFor(input: ProtectorUnlockInput): Opener {
  const secret = (input.secret ?? "").trim();
  return async (record, context) => {
    if (record.kind === "recovery-key" && secret) {
      return openWithRecoveryKey({ context, record, secretB64: secret });
    }
    if (record.kind === "age-recipient" && isAgeIdentity(secret)) {
      return openAgeCapsule(record, context, secret);
    }
    if (record.kind === "age-webauthn") {
      return openAgeWebauthn(
        input.ageWebauthnCrypto
          ? { context, record, crypto: input.ageWebauthnCrypto }
          : { context, record },
      );
    }
    throw new ProtectionError("unavailable", "Nothing to open with.");
  };
}

/**
 * The root the first enrolled capsule of this kind opens to. Throws
 * `WrongPasswordError` when none does.
 */
export async function openRootWithProtector(
  header: VaultHeader,
  input: ProtectorUnlockInput,
): Promise<Uint8Array> {
  const manifest = header.protection;
  const records = manifest ? capsuleRecordsFor(header, input.method) : [];
  const open = openerFor(input);
  for (const record of records) {
    if (!manifest) break;
    if (input.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    try {
      const root = await open(record, contextFor(manifest, record));
      if (input.signal?.aborted) {
        // The person left this tab while the prompt was up: spend nothing.
        root.fill(0);
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return root;
    } catch (error) {
      if (isUncountedProtectorFailure(error)) throw error;
      // This capsule is not the one the material opens; try the next.
    }
  }
  throw new WrongPasswordError(protectorUnlockMiss(input.method));
}
