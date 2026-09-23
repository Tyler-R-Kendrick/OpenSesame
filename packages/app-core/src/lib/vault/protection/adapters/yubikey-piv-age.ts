/**
 * YubiKey PIV / age-plugin-yubikey root protector (KP-29).
 * Browser cannot drive PIV; capabilities report requires-native-client.
 * Enrollment/open must go through `opensesame pass protect` on a machine
 * with the plugin and hardware present.
 */

import type {
  ProtectorAvailability,
  YubikeyPivAgeProtectorRecord,
} from "@opensesame/vault-core";
import { ProtectionError } from "../errors.js";

export function yubikeyPivAgeCapabilities(): ProtectorAvailability {
  return {
    implementation: "implemented",
    runtime: "requires-native-client",
    authorization: "not-required",
    reasonCode: "piv-requires-native-age-plugin-yubikey",
  };
}

export function assertYubikeyPivAgeNativeOnly(): never {
  throw new ProtectionError(
    "unsupported_runtime",
    "YubiKey PIV age protection requires the native client (age-plugin-yubikey).",
  );
}

export type YubikeyPivAgeDescription = {
  protectorId: string;
  recipient: string;
};

/** Parse a native-enrolled record shape for display — no crypto in browser. */
export function describeYubikeyPivAgeRecord(
  record: YubikeyPivAgeProtectorRecord,
): YubikeyPivAgeDescription {
  return {
    protectorId: record.protectorId,
    recipient: record.recipient,
  } satisfies YubikeyPivAgeDescription;
}
