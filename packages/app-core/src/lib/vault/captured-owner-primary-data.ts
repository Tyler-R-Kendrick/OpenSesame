/** Genuine primary cryptographic DATA. Only private Store provenance can issue an owner or REAL. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  ROOT_KEY_BYTES,
  type VaultHeader,
  WrongPasswordError,
  importVaultKey,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { z } from "zod";
import { passwordBytes } from "../retired-credentials/argon-verifier.js";
import { deriveCapturedAgePasskeyRootData } from "./captured-age-passkey-primary-data.js";
import { capturePasskeyPrimaryCeremonyData } from "./captured-passkey-primary-ceremony-data.js";
import { protectorToUnlockRecord } from "./protection/adapters/webauthn-prf-ops.js";
import { capsuleRecordsFor } from "./protection/unlock-protector-methods.js";
import {
  isUncountedProtectorFailure,
  openRootWithProtector,
  protectorUnlockMiss,
} from "./protection/unlock-protector-open.js";
import {
  listPasskeyUnlockRecords,
  unwrapVaultKeyWithPin,
  unwrapVaultKeyWithPrf,
} from "./unlock-factor-crypto.js";

const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("password"), secret: z.string().max(4096) }),
  z.strictObject({ kind: z.literal("pin"), secret: z.string().max(4096) }),
  z.strictObject({ kind: z.literal("passkey") }),
  z.strictObject({
    kind: z.literal("protector"),
    method: z.enum(["recovery", "age", "agePasskey"]),
    secret: z.string().max(4096).optional(),
  }),
]);
export type CapturedOwnerPrimaryRequest = z.infer<typeof requestSchema>;
const actualSecretBytes = passwordBytes;
const actualPassword = unwrapRawVaultKeyFromPassword;
const actualPin = unwrapVaultKeyWithPin;
const actualProbe = capturePasskeyPrimaryCeremonyData;
const actualRecords = listPasskeyUnlockRecords;
const actualCapsules = capsuleRecordsFor;
const actualCapsuleWrap = protectorToUnlockRecord;
const actualPrf = unwrapVaultKeyWithPrf;
const actualProtector = openRootWithProtector;
const actualImport = importVaultKey;
const actualAgePasskey = deriveCapturedAgePasskeyRootData;
const actualUncounted = isUncountedProtectorFailure;
const actualProtectorMiss = protectorUnlockMiss;
const PIN_MISS = "That PIN did not unlock the vault.";
const PASSKEY_MISS = "That passkey did not unlock the vault.";
/** Primitive requests copied before asynchronous work; test crypto/verdicts/roots are never input. */
export function copyCapturedOwnerPrimaryRequest(input: BoundaryValue) {
  const request = requestSchema.parse(input);
  if ("secret" in request && request.secret !== undefined) {
    const bytes = actualSecretBytes(request.secret);
    bytes.fill(0);
  }
  return Object.freeze(request);
}

async function passkeyRoot(
  header: VaultHeader,
  check: () => void,
  failed: () => void,
  signal?: AbortSignal,
) {
  const records = [...actualRecords(header.unlocks)];
  for (const capsule of actualCapsules(header, "passkey")) {
    if (capsule.kind === "webauthn-prf")
      records.push(actualCapsuleWrap(capsule));
  }
  const unique = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    const prior = unique.get(record.credentialIdB64);
    if (prior) {
      if (
        prior.prfSaltB64 !== record.prfSaltB64 ||
        prior.wrap.ivB64 !== record.wrap.ivB64 ||
        prior.wrap.ctB64 !== record.wrap.ctB64
      )
        throw new WrongPasswordError(PASSKEY_MISS);
      // Keep the first actual legacy record; capsule user IDs are not wrap identity.
    } else unique.set(record.credentialIdB64, record);
  }
  if (!unique.size) {
    failed();
    throw new WrongPasswordError(PASSKEY_MISS);
  }
  const probe = await actualProbe([...unique.values()], check, signal);
  try {
    check();
    const selected = [...unique.values()].filter(
      (record) => record.credentialIdB64 === probe.credentialIdB64,
    );
    if (selected.length !== 1 || !selected[0])
      throw new WrongPasswordError(PASSKEY_MISS);
    return await actualPrf(selected[0], probe.prfOutput);
  } finally {
    new Uint8Array(probe.prfOutput).fill(0);
  }
}
async function deriveProtectorPrimary(
  header: VaultHeader,
  request: Extract<CapturedOwnerPrimaryRequest, { kind: "protector" }>,
  check: () => void,
  signal?: AbortSignal,
) {
  if (request.method === "agePasskey")
    return await actualAgePasskey(header, check, signal);
  // Existing software age crypto cannot cancel; retain actual completion before checking cancellation.
  return await actualProtector(header, {
    method: request.method,
    ...(request.secret !== undefined ? { secret: request.secret } : {}),
  });
}
/**
 * This function never writes storage, activates a session or returns a factors-complete verdict.
 * Its caller must authenticate the exact physical HEADER/BODY/MAC/full binding with these
 * bytes and consume genuine configured second steps before private authority issuance.
 */
export async function deriveCapturedOwnerPrimaryData(
  header: VaultHeader,
  request: CapturedOwnerPrimaryRequest,
  original: () => void,
  failed: () => void,
  signal?: AbortSignal,
) {
  const selected = copyCapturedOwnerPrimaryRequest(request);
  const capturedHeader: VaultHeader = structuredClone(header);
  const check = () => {
    original();
    if (signal?.aborted)
      throw new DOMException("The operation was aborted.", "AbortError");
  };
  check();
  let counted = false;
  const markFailed = () => {
    check();
    if (!counted) {
      counted = true;
      failed();
    }
  };
  let raw: Uint8Array | undefined;
  try {
    if (selected.kind === "password") {
      if (!capturedHeader.kdf || !capturedHeader.wrap)
        throw new WrongPasswordError();
      raw = await actualPassword(capturedHeader, selected.secret);
    } else if (selected.kind === "pin") {
      const record = capturedHeader.unlocks?.pin;
      if (!record) throw new WrongPasswordError(PIN_MISS);
      raw = await actualPin(record, selected.secret);
    } else if (selected.kind === "passkey") {
      raw = await passkeyRoot(capturedHeader, check, markFailed, signal);
    } else {
      raw = await deriveProtectorPrimary(
        capturedHeader,
        selected,
        check,
        signal,
      );
    }
    check();
    if (raw.length !== ROOT_KEY_BYTES) throw new WrongPasswordError();
    const key = await actualImport(raw);
    check();
    return Object.freeze({ raw, key, primary: selected.kind });
  } catch (error) {
    raw?.fill(0);
    check();
    if (actualUncounted(error)) throw error;
    if (error instanceof WrongPasswordError) {
      markFailed();
      throw error;
    }
    if (selected.kind === "protector") {
      markFailed();
      throw new WrongPasswordError(actualProtectorMiss(selected.method));
    }
    throw error;
  }
}
