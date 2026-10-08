import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type StringFields,
  writeDeviceRows,
  writeDeviceSecrets,
} from "../device-connector-records.js";
import { clearNotices, listNotices } from "../notices.js";
import { vfsSeams } from "../vfs-seams.js";
import { HEADER_PATH, tombFileKey } from "../vfs.js";
import { installSavedBucket } from "./bucket-boot.js";
import { hasSavedBucket } from "./bucket-saved.js";
import {
  ACCESS_KEY,
  BUCKET_NAME,
  ENDPOINT,
  REGION,
  SECRET_KEY,
  fakeBucket,
} from "./s3.test-support.js";

const row = (fields: StringFields) => ({
  connectionId: "conn_local_s3",
  providerId: "s3",
  displayName: "Bucket",
  scopes: [],
  fields,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
});

const WHOLE = {
  endpoint: "http://localhost:1",
  region: "eu-west-1",
  bucket: "vault-bucket",
  access_key_id: "AKIATEST",
};

describe("booting from a saved bucket", () => {
  const before = { ...vfsSeams };
  beforeEach(() => {
    writeDeviceRows([]);
    writeDeviceSecrets({});
    clearNotices();
  });
  afterEach(() => {
    Object.assign(vfsSeams, before);
    clearNotices();
  });

  it("asks for nothing when no bucket is saved", async () => {
    expect(await hasSavedBucket()).toBe(false);
  });

  it("sees a saved bucket", async () => {
    writeDeviceRows([row(WHOLE)]);
    expect(await hasSavedBucket()).toBe(true);
  });

  it("names what a half-saved bucket lacks, leaves the VFS alone, and tells the tray", async () => {
    writeDeviceRows([row({ endpoint: WHOLE.endpoint })]);
    const result = await installSavedBucket();
    expect(result).toMatchObject({ state: "failed" });
    expect(result.state === "failed" && result.reason).toContain(
      "secret_access_key",
    );
    expect(vfsSeams.readRaw).toBe(before.readRaw);
    expect(listNotices().map((notice) => notice.id)).toContain("boot:bucket");
  });

  it("keeps the vault's plaintext files in the bucket once installed, and hands the VFS back on uninstall", async () => {
    const bucket = fakeBucket(50);
    vi.stubGlobal("fetch", bucket.fetch);
    try {
      writeDeviceRows([
        row({
          endpoint: ENDPOINT,
          region: REGION,
          bucket: BUCKET_NAME,
          prefix: "vaults/me",
          access_key_id: ACCESS_KEY,
        }),
      ]);
      writeDeviceSecrets({ conn_local_s3: { secret_access_key: SECRET_KEY } });
      const result = await installSavedBucket();
      expect(result.state).toBe("installed");
      expect(vfsSeams.readRaw).not.toBe(before.readRaw);
      await vfsSeams.writeRaw(tombFileKey("personal", HEADER_PATH), "{}");
      expect(
        [...bucket.objects.keys()].some((key) => key.startsWith("vaults/me/")),
      ).toBe(true);
      if (result.state === "installed") result.uninstall();
      expect(vfsSeams.readRaw).toBe(before.readRaw);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves the emulation in place when the bucket cannot be reached, without leaking the key", async () => {
    writeDeviceRows([row(WHOLE)]);
    writeDeviceSecrets({
      conn_local_s3: { secret_access_key: "top-secret-key-value" },
    });
    const result = await installSavedBucket();
    expect(result.state).toBe("failed");
    expect(JSON.stringify(listNotices())).not.toContain("top-secret-key-value");
    expect(vfsSeams.readRaw).toBe(before.readRaw);
  }, 60_000);
});
