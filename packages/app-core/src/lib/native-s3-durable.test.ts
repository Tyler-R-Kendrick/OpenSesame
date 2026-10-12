import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "./device-connector-records.js";
import { kvForgetAll, kvHydrate } from "./kv.js";
import { configureNativeS3, verifyNativeS3 } from "./native-s3.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function stagedDisk() {
  const files = new Map<string, string>();
  let beforeWrite = async () => {};
  let aborted = 0;
  return {
    files,
    hold: (next: () => Promise<void>) => {
      beforeWrite = next;
    },
    aborted: () => aborted,
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create)
          throw new DOMException("Missing", "NotFoundError");
        files.set(name, "");
      }
      return {
        async getFile() {
          const text = files.get(name) ?? "";
          return { size: text.length, text: async () => text };
        },
        async createWritable() {
          let staged = files.get(name) ?? "";
          return {
            async write(value: string) {
              staged = value;
              await beforeWrite();
            },
            async close() {
              files.set(name, staged);
            },
            async abort() {
              aborted++;
            },
          };
        },
      };
    },
  };
}

beforeEach(() => {
  kvForgetAll();
  forgetAtRestKeyForTest();
});
afterEach(() => {
  kvForgetAll();
  forgetAtRestKeyForTest();
  configureHost(createTestHost());
});

it.each(["new", "edit", "verify"])(
  "aborts a %s S3 grant at the real staged storage boundary when its activation is disposed",
  async (operation) => {
    const disk = stagedDisk();
    configureHost(
      createTestHost({
        originFiles: async () => overlapCast(disk),
        locks: overlapCast(webLocksDouble()),
      }),
    );
    let disposed = false;
    const transport = {
      assertCurrent: () => {
        if (disposed) throw new Error("Activation disposed");
      },
      fetch: async () =>
        new Response(
          "<ListBucketResult><Name>test-bucket</Name><Prefix/><IsTruncated>false</IsTruncated></ListBucketResult>",
        ),
    };
    const input = {
      providerId: "s3",
      displayName: "S3",
      parameters: {
        endpoint: "https://minio.example.test",
        region: "us-east-1",
        bucket: "test-bucket",
        access_key_id: "public-key",
        prefix: "",
      },
      credentials: { secret_access_key: "private-signing-key" },
    };
    const saved =
      operation === "new" ? null : await configureNativeS3(input, transport);
    const original = readDeviceRows();
    const entered = deferred();
    const resume = deferred();
    disk.hold(async () => {
      entered.resolve();
      await resume.promise;
    });
    const pending =
      operation === "verify" && saved
        ? verifyNativeS3(saved.connectionId, transport)
        : configureNativeS3(
            saved
              ? {
                  ...input,
                  connectionId: saved.connectionId,
                  revision: saved.revision,
                  displayName: "Changed name",
                }
              : input,
            transport,
          );
    const refused = expect(pending).rejects.toThrow("Activation disposed");
    await entered.promise;
    disposed = true;
    resume.resolve();
    await refused;
    expect(disk.aborted()).toBe(1);
    expect(readDeviceRows()).toEqual(original);
    kvForgetAll();
    await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
    expect(readDeviceRows()).toEqual(original);
  },
);
