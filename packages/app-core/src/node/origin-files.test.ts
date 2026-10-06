import {
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { nodeOriginFiles } from "./origin-files.js";
let directory = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "origin-files-proof-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
it("atomically persists bounded file content across independently reopened ports", async () => {
  const root = await nodeOriginFiles(directory)();
  const handle = await root.getFileHandle("sealed-record", { create: true });
  const writer = await handle.createWritable();
  await writer.write("sealed record");
  await writer.close();
  const reopened = await nodeOriginFiles(directory)();
  expect(
    await (
      await (await reopened.getFileHandle("sealed-record")).getFile()
    ).text(),
  ).toBe("sealed record");
  if (process.platform !== "win32")
    expect(statSync(join(directory, "sealed-record")).mode & 0o777).toBe(0o600);
});
it("rejects traversal and symlink-backed records before reading outside the origin", async () => {
  const root = await nodeOriginFiles(directory)();
  await expect(
    root.getFileHandle("../outside", { create: true }),
  ).rejects.toThrow();
  writeFileSync(join(directory, "target"), "private");
  symlinkSync(join(directory, "target"), join(directory, "symlink"));
  await expect(root.getFileHandle("symlink")).rejects.toThrow();
});
it("abort leaves the last committed content intact", async () => {
  const root = await nodeOriginFiles(directory)();
  const handle = await root.getFileHandle("record", { create: true });
  const writer = await handle.createWritable();
  await writer.write("committed");
  await writer.close();
  const aborted = await handle.createWritable();
  await aborted.write("uncommitted");
  await aborted.abort();
  expect(await (await handle.getFile()).text()).toBe("committed");
});
