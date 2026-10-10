/** Fixed record DATA shared by browser and indexed native identity producers. */
import type { DeviceIdentityKeyRecord } from "@opensesame/vault-core";

export type OriginalDeviceIdentityRecordIOData = Readonly<{
  check(): void;
  read(): Promise<DeviceIdentityKeyRecord | null>;
  write(record: DeviceIdentityKeyRecord | null): Promise<void>;
  close(): Promise<void>;
}>;
