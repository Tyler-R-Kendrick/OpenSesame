/**
 * Browser formats interop for root-protection metadata (Formats panel).
 *
 * - Native: authenticated manifest JSON (no secrets).
 * - age: armor-encode / decode ciphertext payloads with typage.
 * - SOPS YAML/JSON: not available in-browser; use `opensesame pass protect
 *   sops-encrypt|sops-decrypt` with OPENSESAME_SOPS_BIN (both directions).
 */

import * as age from "age-encryption";
import { isAgeIdentity, isAgeRecipient } from "../../age-keys.js";
import { ProtectionError } from "./errors.js";
import type { RootProtectionManifest } from "./types.js";

export type FormatCapability =
  | { available: true; runtime: "browser" }
  | { available: true; runtime: "native-client" }
  | { available: false; runtime: "unavailable"; reason: string };

export function nativeManifestCapability(): FormatCapability {
  return { available: true, runtime: "browser" };
}

export function ageCapability(): FormatCapability {
  return { available: true, runtime: "browser" };
}

export function sopsCapability(): FormatCapability {
  return {
    available: true,
    runtime: "native-client",
  };
}

export function gpgCapability(): FormatCapability {
  return {
    available: false,
    runtime: "unavailable",
    reason: "GPG write is not available in this browser.",
  };
}

/** Export the authenticated manifest as pretty JSON (metadata only). */
export function exportNativeManifestJson(
  manifest: RootProtectionManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** age-encrypt bytes to armored ciphertext for a recipient list. */
export async function exportAgeArmored(
  plaintext: Uint8Array,
  recipients: readonly string[],
): Promise<string> {
  const cleaned = [
    ...new Set(recipients.map((line) => line.trim()).filter(isAgeRecipient)),
  ];
  if (cleaned.length === 0) {
    throw new ProtectionError(
      "malformed_encoding",
      "age export needs at least one recipient.",
    );
  }
  const encrypter = new age.Encrypter();
  for (const recipient of cleaned) encrypter.addRecipient(recipient);
  const ciphertext = await encrypter.encrypt(plaintext);
  return age.armor.encode(ciphertext);
}

/** age-decrypt armored ciphertext with an identity. */
export async function importAgeArmored(
  armored: string,
  identity: string,
): Promise<Uint8Array> {
  if (!isAgeIdentity(identity)) {
    throw new ProtectionError(
      "unavailable",
      "age import needs a valid identity.",
    );
  }
  const decoded = age.armor.decode(armored);
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(identity);
  return decrypter.decrypt(decoded, "uint8array");
}

/** Honest SOPS both-directions pointer for Formats / operators. */
export function sopsNativeBothDirectionsHint(): string {
  return [
    "opensesame pass protect sops-encrypt --format yaml|json",
    "opensesame pass protect sops-decrypt --format yaml|json --reveal",
    "Requires OPENSESAME_SOPS_BIN to an absolute sops binary.",
  ].join("\n");
}
