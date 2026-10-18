/** Actual installed native process controls; no fake process ACK can satisfy these. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureHost } from "@opensesame/app-core/host.js";
import { createNodeHost } from "@opensesame/app-core/node/host.js";
import { expect, it } from "vitest";
import { createNativeVaultPorts } from "./native-vault-ports.js";
const executable = process.env.OPENSESAME_NATIVE_TEST_BINARY;
if (!executable)
  throw new Error(
    "OPENSESAME_NATIVE_TEST_BINARY must identify the actual built native companion.",
  );
it("holds genuine CRED/BODY across original projection reads and durable exact header publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensesame-native-ports-"));
  const tomb = "selected";
  const directory = join(root, "vault", tomb);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "origin-files"), { mode: 0o700 });
  await writeFile(
    join(root, "at-rest.key"),
    `${Buffer.alloc(32, 41).toString("base64")}\n`,
    { mode: 0o600 },
  );
  const originalHeader = JSON.stringify({ sealed: "original-header-data" });
  await writeFile(join(directory, "header.json"), originalHeader, {
    mode: 0o600,
  });
  await writeFile(
    join(directory, "vault.json"),
    JSON.stringify({ sealed: "encrypted-manifest-data" }),
    { mode: 0o600 },
  );
  const ports = createNativeVaultPorts(root, executable);
  configureHost({ ...createNodeHost({ stateDir: root }), ...ports });
  try {
    await ports.locks.request(
      "opensesame.retired-credentials",
      { mode: "exclusive" },
      async () => {
        await ports.locks.request(
          `opensesame:vault-body:${tomb}`,
          { mode: "exclusive" },
          async () => {
            const auth = await ports.physicalVaultAuthentication.capture(
              tomb,
              () => {},
            );
            const before = await auth.read();
            expect(before.header).toBe(originalHeader);
            const originalIdentity = await auth.readOriginalStateIdentity?.();
            const device = await ports.physicalDeviceRecords.capture(() => {});
            expect(await device.readOriginalStateIdentity?.()).toBe(
              originalIdentity,
            );
            expect(
              await device.read(`tomb/${tomb}/retired-credentials.v2`, 32768),
            ).toBeNull();
            const publication = await ports.physicalVaultPublication.capture(
              tomb,
              () => {},
            );
            const next = JSON.stringify({ sealed: "next-header-data" });
            await publication.publishHeader(before, next);
            expect(await readFile(join(directory, "header.json"), "utf8")).toBe(
              next,
            );
            await expect(
              publication.publishHeader(before, "stale"),
            ).rejects.toThrow();
            await device.publish(
              `tomb/${tomb}/retired-credentials.v2`,
              null,
              "encrypted-inner-record-data",
              32768,
            );
            expect(
              await device.read(`tomb/${tomb}/retired-credentials.v2`, 32768),
            ).toBe("encrypted-inner-record-data");
          },
        );
      },
    );
  } finally {
    await ports.locks.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
