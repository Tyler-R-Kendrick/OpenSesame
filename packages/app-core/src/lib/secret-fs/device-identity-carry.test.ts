import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceKeyField } from "@opensesame/vault-core";
import { Effect, Redacted } from "effect";
import { expect, it } from "vitest";
import { nodeSecretFiles } from "../../node/secret-files.js";
import { genuineRecord } from "../__tests__/device-identity-records.js";
import {
  readStoredDeviceIdentityKey,
  writeStoredDeviceIdentityKey,
} from "../device-identity-key.js";
import { bodyPortOf } from "../vault/store-device-key.js";
import { PASSWORD, newStore } from "../vault/store-ops.fixture.js";
import { installUnlockRacesFixture } from "../vault/store-unlock-races.fixture.js";
import { installFileBackedVfs } from "./install.js";
import { makeMemorySecretFiles } from "./memory.js";
import { resilient } from "./resilient.js";
import { makeS3SecretFiles } from "./s3.js";
import {
  ACCESS_KEY,
  BUCKET_NAME,
  ENDPOINT,
  REGION,
  SECRET_KEY,
  fakeBucket,
} from "./s3.test-support.js";

installUnlockRacesFixture();

const backends = [
  [
    "memory",
    async () => ({ files: makeMemorySecretFiles(), cleanup: async () => {} }),
  ],
  [
    "directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "identity-carry-"));
      return {
        files: await Effect.runPromise(nodeSecretFiles(root)),
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  ],
  [
    "S3 with retries",
    async () => ({
      files: await Effect.runPromise(
        resilient(
          makeS3SecretFiles({
            endpoint: ENDPOINT,
            region: REGION,
            bucket: BUCKET_NAME,
            credentials: {
              accessKeyId: ACCESS_KEY,
              secretAccessKey: Redacted.make(SECRET_KEY),
            },
            fetch: fakeBucket(50).fetch,
          }),
        ),
      ),
      cleanup: async () => {},
    }),
  ],
] as const;

for (const [name, make] of backends) {
  it.each(["adopts", "replaces"] as const)(
    `the installed ${name} adapter %s its local identity with the stronger carried key`,
    async (mode) => {
      const backend = await make();
      const restore = await installFileBackedVfs(backend.files);
      const source = newStore();
      const reopened = newStore();
      try {
        await source.create(PASSWORD);
        const carried = await genuineRecord(Date.now() - 1_000);
        await bodyPortOf(source).mutate((body) => {
          body.deviceIdentityKey = deviceKeyField(carried);
        });
        if (mode === "replaces")
          await writeStoredDeviceIdentityKey(
            "personal",
            await genuineRecord(Date.now()),
          );
        source.lock();
        reopened.rehydrate();
        await reopened.unlock(PASSWORD);
        expect(reopened.isUnlocked()).toBe(true);
        expect((await readStoredDeviceIdentityKey("personal"))?.keyId).toBe(
          carried.keyId,
        );
      } finally {
        await source.flushPendingWrites();
        await reopened.flushPendingWrites();
        source.lock();
        reopened.lock();
        restore();
        await backend.cleanup();
      }
    },
  );
}
