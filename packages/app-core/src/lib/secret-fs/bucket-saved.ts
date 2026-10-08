/**
 * Is a bucket saved on this device? (ADR 0182) The one question the Pages
 * boot asks before deciding whether to load the file store at all, so it
 * reads only the small device-connector record and imports nothing of Effect
 * or the S3 client: a device with no bucket pays nothing for the capability.
 */
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "../device-connector-records.js";
import { kvHydrate } from "../kv.js";
import { S3_PROVIDER_ID } from "./s3-config.js";

export async function hasSavedBucket(): Promise<boolean> {
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  return readDeviceRows().some((row) => row.providerId === S3_PROVIDER_ID);
}
