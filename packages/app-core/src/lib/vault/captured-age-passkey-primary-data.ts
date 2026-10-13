/** Actual pinned age decryption with its protected getCredential extension bound to the original Host. No caller crypto/verdict seam. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type VaultHeader,
  WrongPasswordError,
  b64ToBytes,
} from "@opensesame/vault-core";
import { z } from "zod";
import { loadAge } from "../age-lib.js";
import { assertUnambiguousJson } from "../retired-credentials/json-preflight.js";
import { captureAgePasskeyCeremonyData } from "./captured-age-passkey-ceremony-data.js";
import { parseAgeWebauthnCapsuleData } from "./protection/adapters/age-webauthn.js";
import { ProtectionError } from "./protection/errors.js";
import { verifyManifestAuth } from "./protection/manifest-auth.js";
import { capsuleRecordsFor } from "./protection/unlock-protector-methods.js";
import {
  UNLOCK_AGE_PASSKEY_MISS,
  isUncountedProtectorFailure,
} from "./protection/unlock-protector-open.js";
const actualAge = loadAge;
const actualCeremony = captureAgePasskeyCeremonyData;
const actualPayload = parseAgeWebauthnCapsuleData;
const actualManifest = verifyManifestAuth;
const actualRecords = capsuleRecordsFor;
const transport = z.enum(["ble", "hybrid", "internal", "nfc", "usb"]);
const originalId = z
  .instanceof(Uint8Array)
  .refine((id) => id.length > 0 && id.length <= 1024);
type AgeLibrary = Awaited<ReturnType<typeof actualAge>>;
type VendorIdentity = InstanceType<AgeLibrary["webauthn"]["WebAuthnIdentity"]>;
function ownData(instance: VendorIdentity, name: string) {
  const descriptor = Object.getOwnPropertyDescriptor(instance, name);
  if (!descriptor || !("value" in descriptor))
    throw new ProtectionError(
      "unsupported_runtime",
      "Pinned age identity ABI is unavailable.",
    );
  const value: BoundaryValue = descriptor.value;
  return value;
}
function capturedIdentityClass(
  OriginalIdentity: Awaited<
    ReturnType<typeof actualAge>
  >["webauthn"]["WebAuthnIdentity"],
  ceremony: ReturnType<typeof actualCeremony>,
  outputs: ArrayBuffer[],
) {
  return class CapturedIdentity extends OriginalIdentity {
    readonly #id: Uint8Array;
    readonly #rp: string;
    readonly #transports: AuthenticatorTransport[];
    constructor(identity: string) {
      super({ identity });
      // The pinned vendor constructor decode-validates its identity encoding.
      // Read only its own concrete data fields; unsupported vendor shapes refuse instead of using ambient navigator.
      this.#id = originalId.parse(ownData(this, "credId")).slice();
      this.#rp = z.string().min(1).max(253).parse(ownData(this, "rpId"));
      this.#transports = z
        .array(transport)
        .max(8)
        .parse(ownData(this, "transports"));
    }
    protected override async getCredential(
      nonce: Uint8Array,
    ): Promise<AuthenticationExtensionsPRFValues> {
      const result = await ceremony(
        this.#id,
        this.#rp,
        this.#transports,
        nonce,
      );
      outputs.push(result.first, result.second);
      return result;
    }
  };
}
function assertOriginalAgePrimary(original: () => void, signal?: AbortSignal) {
  original();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
function pinOriginalAgeVendor(age: AgeLibrary) {
  const OriginalIdentity = age.webauthn.WebAuthnIdentity;
  const originalUnwrap = OriginalIdentity.prototype.unwrapFileKey;
  const OriginalDecrypter = age.Decrypter;
  const originalAdd = OriginalDecrypter.prototype.addIdentity;
  const originalDecrypt: (
    this: InstanceType<typeof OriginalDecrypter>,
    file: Uint8Array,
    outputFormat?: "uint8array",
  ) => Promise<Uint8Array> = OriginalDecrypter.prototype.decrypt;
  return {
    OriginalIdentity,
    originalUnwrap,
    OriginalDecrypter,
    originalAdd,
    originalDecrypt,
  };
}
type CapturedAgeRecord = Extract<
  ReturnType<typeof actualRecords>[number],
  { kind: "age-webauthn" }
>;
function originalAgeDecryptionInput(
  vendor: ReturnType<typeof pinOriginalAgeVendor>,
  CapturedIdentity: ReturnType<typeof capturedIdentityClass>,
  record: CapturedAgeRecord,
) {
  const decrypt = new vendor.OriginalDecrypter();
  const identity = new CapturedIdentity(record.recipient);
  Object.defineProperty(identity, "unwrapFileKey", {
    value: vendor.originalUnwrap.bind(identity),
    writable: false,
    configurable: false,
  });
  vendor.originalAdd.call(decrypt, identity);
  const bytes = b64ToBytes(record.capsuleAgeB64);
  if (bytes.length > 65536)
    throw new WrongPasswordError(UNLOCK_AGE_PASSKEY_MISS);
  return { decrypt, bytes };
}
/** Returned root is cryptographic DATA. Actual private primary and full factor admission remain the caller's job. */
export async function deriveCapturedAgePasskeyRootData(
  header: VaultHeader,
  original: () => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const ceremony = actualCeremony(original, signal);
  const selected: VaultHeader = structuredClone(header);
  const manifest = selected.protection;
  if (!manifest) throw new WrongPasswordError(UNLOCK_AGE_PASSKEY_MISS);
  const records = actualRecords(selected, "agePasskey");
  if (records.length < 1 || records.length > 32)
    throw new WrongPasswordError(UNLOCK_AGE_PASSKEY_MISS);
  const age = await actualAge();
  assertOriginalAgePrimary(original, signal);
  const vendor = pinOriginalAgeVendor(age);
  for (const record of records) {
    if (record.kind !== "age-webauthn") continue;
    const outputs: ArrayBuffer[] = [];
    let plaintext: Uint8Array | undefined;
    let root: Uint8Array | undefined;
    const CapturedIdentity = capturedIdentityClass(
      vendor.OriginalIdentity,
      ceremony,
      outputs,
    );
    try {
      original();
      const { decrypt, bytes } = originalAgeDecryptionInput(
        vendor,
        CapturedIdentity,
        record,
      );
      const decoded = await vendor.originalDecrypt.call(
        decrypt,
        bytes,
        "uint8array",
      );
      if (!(decoded instanceof Uint8Array))
        throw new WrongPasswordError(UNLOCK_AGE_PASSKEY_MISS);
      plaintext = decoded;
      assertOriginalAgePrimary(original, signal);
      assertUnambiguousJson(
        new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
        8192,
      );
      root = actualPayload(plaintext, {
        vaultId: manifest.vaultId,
        rootKeyId: manifest.rootKeyId,
        rootEpoch: manifest.rootEpoch,
        protectorId: record.protectorId,
        purpose: manifest.purpose,
      });
      await actualManifest(root, manifest);
      assertOriginalAgePrimary(original, signal);
      const accepted = root;
      root = undefined;
      return accepted;
    } catch (error) {
      assertOriginalAgePrimary(original, signal);
      if (isUncountedProtectorFailure(error)) throw error;
    } finally {
      root?.fill(0);
      plaintext?.fill(0);
      for (const output of outputs) new Uint8Array(output).fill(0);
    }
  }
  throw new WrongPasswordError(UNLOCK_AGE_PASSKEY_MISS);
}
