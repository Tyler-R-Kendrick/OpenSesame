/**
 * Device-local root protector — platform keystore / Secure Enclave style.
 * Not available in a generic browser; native client only.
 */

import { ProtectionError } from "../errors.js";
import type {
  DeviceLocalProtectorRecord,
  ProtectorAvailability,
} from "../types.js";

export function deviceLocalCapabilities(): ProtectorAvailability {
  return {
    implementation: "implemented",
    runtime: "requires-native-client",
    authorization: "not-required",
    reasonCode: "device-local-requires-native-keystore",
  };
}

export function assertDeviceLocalNativeOnly(): never {
  throw new ProtectionError(
    "unsupported_runtime",
    "Device-local protection requires the native client keystore.",
  );
}

export type DeviceLocalDescription = {
  protectorId: string;
};

export function describeDeviceLocalRecord(
  record: DeviceLocalProtectorRecord,
): DeviceLocalDescription {
  return { protectorId: record.protectorId } satisfies DeviceLocalDescription;
}
