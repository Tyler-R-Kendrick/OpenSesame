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
import { verifyManifestAuth } from "./manifest-auth.js";
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

/**
 * Whether the opened root is the one the manifest was authenticated under. The
 * MAC is root-derived, so only the real root verifies it: this is the root
 * commitment that an age capsule, which anyone can seal, does not carry itself.
 */
async function rootVerifiesManifest(
  root: Uint8Array,
  manifest: RootProtectionManifest,
): Promise<boolean> {
  try {
    await verifyManifestAuth(root, manifest);
    return true;
  } catch {
    return false;
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Settle with the work, or as soon as the signal aborts, whichever is first.
 * The age library's WebAuthn calls take no signal, so the prompt itself stays
 * up until the next ceremony replaces it; waiting on it would hold the screen.
 * A root that arrives after the abort is zeroed and spent nowhere.
 */
function untilAborted(
  work: Promise<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (root) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          root.fill(0);
          reject(abortError());
        } else resolve(root);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
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
    if (record.kind === "age-recipient" && (await isAgeIdentity(secret))) {
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
    if (input.signal?.aborted) throw abortError();
    try {
      const root = await untilAborted(
        open(record, contextFor(manifest, record)),
        input.signal,
      );
      if (await rootVerifiesManifest(root, manifest)) {
        if (!input.signal?.aborted) return root;
        root.fill(0);
        throw abortError();
      }
      // An age capsule is public-key encryption with a public context: anyone
      // who can write the header can seal one to a root of their choosing. A
      // root the manifest's MAC does not verify under is not this vault's.
      root.fill(0);
    } catch (error) {
      // Whatever ended after the person left this tab is theirs, not a guess:
      // the age library cannot cancel its WebAuthn prompt, so a failure that
      // lands late must not be counted against the lockout.
      if (input.signal?.aborted) throw abortError();
      if (isUncountedProtectorFailure(error)) throw error;
      // This capsule is not the one the material opens; try the next.
    }
  }
  if (input.signal?.aborted) throw abortError();
  throw new WrongPasswordError(protectorUnlockMiss(input.method));
}
