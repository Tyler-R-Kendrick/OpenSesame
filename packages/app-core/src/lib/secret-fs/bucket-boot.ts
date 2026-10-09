/**
 * Boot the vault from the bucket saved on this device (ADR 0182). Called by
 * the Pages boot only when `hasSavedBucket()` is true, after the at-rest key
 * and before any vault header is read, so the unlock screen sees the bucket's
 * vaults and nothing else. With no bucket saved nothing changes: the PWA runs
 * on its emulated VFS in OPFS, and never on a real filesystem.
 *
 * A bucket that cannot be reached leaves the emulation in place and says why
 * in the tray. It never half-installs, and it never writes a vault to one
 * store while the person believes it is in the other.
 */
import { Effect } from "effect";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "../device-connector-records.js";
import { setStatusNotice } from "../notices.js";
import { installFileBackedVfs } from "./install.js";
import { resilient } from "./resilient.js";
import { S3_PROVIDER_ID, s3ConfigFrom, s3Missing } from "./s3-config.js";
import { makeS3SecretFiles } from "./s3.js";

export type BucketBoot =
  | Readonly<{ state: "installed"; uninstall: () => void }>
  | Readonly<{ state: "failed"; reason: string }>;

const NOTICE_ID = "boot:bucket";

function failed(reason: string): BucketBoot {
  setStatusNotice({
    id: NOTICE_ID,
    tone: "err",
    title: "Bucket not reached",
    body: `${reason} This device is using its own storage until the bucket answers.`,
  });
  return { state: "failed", reason };
}

function saved() {
  const row = readDeviceRows()
    .filter((item) => item.providerId === S3_PROVIDER_ID)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1);
  if (row === undefined) return null;
  return {
    fields: row.fields,
    secrets: readDeviceSecrets()[row.connectionId] ?? {},
  };
}

export async function installSavedBucket(): Promise<BucketBoot> {
  const connection = saved();
  if (connection === null) return failed("No bucket is saved.");
  const missing = s3Missing(connection);
  if (missing.length > 0) {
    return failed(`The saved bucket is missing ${missing.join(", ")}.`);
  }
  try {
    const config = s3ConfigFrom(connection);
    if (config === null) return failed("The saved bucket is incomplete.");
    const files = await Effect.runPromise(resilient(makeS3SecretFiles(config)));
    return { state: "installed", uninstall: await installFileBackedVfs(files) };
  } catch (error) {
    // The message names a path or a reason; no store error carries a credential.
    return failed(
      error instanceof Error ? error.message : "It did not answer.",
    );
  }
}
