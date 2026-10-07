import {
  chmod,
  link,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  openPrivateObservationStateFile,
  readPrivateObservationFile,
} from "./credential-observation-files.js";
const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "os-observation-files-"));
  paths.push(path);
  return path;
}
it("rejects symlink, hardlink and broadly accessible independent key files", async () => {
  const dir = await directory();
  const key = join(dir, "key.json");
  const alias = join(dir, "alias.json");
  await writeFile(key, "fixture-generated-key", { mode: 0o600 });
  await symlink(key, alias);
  await expect(readPrivateObservationFile(alias, 8192)).rejects.toThrow();
  await rm(alias);
  await link(key, alias);
  await expect(readPrivateObservationFile(key, 8192)).rejects.toThrow(
    "private receiver file",
  );
  await rm(alias);
  await chmod(key, 0o644);
  await expect(readPrivateObservationFile(key, 8192)).rejects.toThrow(
    "private receiver file",
  );
});
it("holds one private receipt namespace and rejects path replacement before commit", async () => {
  const dir = await directory();
  const receipt = join(dir, "receipts.json");
  const files = await openPrivateObservationStateFile(receipt);
  await expect(openPrivateObservationStateFile(receipt)).rejects.toThrow();
  await files.write('{"fixture":1}');
  expect(await files.read()).toBe('{"fixture":1}');
  const moved = `${dir}.moved`;
  paths.push(moved);
  await rename(dir, moved);
  await expect(files.write('{"fixture":2}')).rejects.toThrow();
  await rename(moved, dir);
  await files.close();
  const reopened = await openPrivateObservationStateFile(receipt);
  expect(await reopened.read()).toBe('{"fixture":1}');
  await reopened.close();
});
it("rejects shared or symlinked receipt directories before creating any state", async () => {
  const dir = await directory();
  await chmod(dir, 0o755);
  await expect(
    openPrivateObservationStateFile(join(dir, "receipts.json")),
  ).rejects.toThrow("private");
  await chmod(dir, 0o700);
  const alias = `${dir}.alias`;
  paths.push(alias);
  await symlink(dir, alias);
  await expect(
    openPrivateObservationStateFile(join(alias, "receipts.json")),
  ).rejects.toThrow("direct private path");
});
