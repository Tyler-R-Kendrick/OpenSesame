import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NATIVE_MINIMUM_FREE,
  NATIVE_TASK_DISK_LIMIT,
  assertNativeResourceLimits,
  assertNativeTaskResources,
  nativeTaskStorage,
} from "./task-resources.mjs";

test("unchanged 27 GiB bound charges only the native task and separately requires real free space", () => {
  // A runner with40GiB of unrelated preinstalled software and8GiB free can build a1GiB task.
  const unrelatedImageOccupied = 40n * 1024n ** 3n;
  assert.ok(unrelatedImageOccupied > NATIVE_TASK_DISK_LIMIT);
  assert.doesNotThrow(() =>
    assertNativeResourceLimits(1024n ** 3n, 8n * 1024n ** 3n),
  );
  assert.doesNotThrow(() =>
    assertNativeResourceLimits(NATIVE_TASK_DISK_LIMIT, NATIVE_MINIMUM_FREE),
  );
  assert.throws(
    () =>
      assertNativeResourceLimits(
        NATIVE_TASK_DISK_LIMIT + 1n,
        NATIVE_MINIMUM_FREE,
      ),
    /27 GiB/,
  );
  assert.throws(
    () => assertNativeResourceLimits(1n, NATIVE_MINIMUM_FREE - 1n),
    /available filesystem/,
  );
});
test("owned usage counts hardlinks once and never traverses unrelated symlink targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "native-task-resource-"));
  const unrelated = await mkdtemp(join(tmpdir(), "unrelated-native-image-"));
  t.after(async () => {
    await rm(root, { recursive: true });
    await rm(unrelated, { recursive: true });
  });
  await writeFile(join(unrelated, "large"), Buffer.alloc(1_048_576));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "small"), Buffer.alloc(8192));
  const before = await nativeTaskStorage(root);
  await link(join(root, "small"), join(root, "alias"));
  assert.equal(await nativeTaskStorage(root), before);
  await symlink(unrelated, join(root, "outside"));
  const after = await nativeTaskStorage(root);
  const linkInfo = await lstat(join(root, "outside"), { bigint: true });
  assert.equal(after, before + linkInfo.blocks * 512n);
  assert.ok(after < 1_048_576n);
  await assert.rejects(
    nativeTaskStorage(join(root, "outside")),
    /owned directory/,
  );
  const receipt = await assertNativeTaskResources(root);
  assert.equal(receipt.ownedBytes, after);
  assert.equal(receipt.limitBytes, NATIVE_TASK_DISK_LIMIT);
});
