/** @vitest-environment node */
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { nodeOriginFiles } from "./origin-files.js";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "origin-files-runtime-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("preserves only the supplied byte-view slice and supports actual seek/truncate/reopen", async () => {
  const root = await nodeOriginFiles(directory)();
  const handle = await root.getFileHandle("record", { create: true });
  const writer = await handle.createWritable();
  const envelope = new Uint8Array([99, 65, 66, 67, 99]);
  await writer.write(new DataView(envelope.buffer, 1, 3));
  await writer.seek(1);
  await writer.write(new Blob(["Z"]));
  await writer.seek(3);
  await writer.write(new Uint8Array([68]).buffer);
  await writer.truncate(3);
  await writer.close();
  const reopened = await nodeOriginFiles(directory)();
  const readHandle = await reopened.getFileHandle("record");
  expect(await (await readHandle.getFile()).text()).toBe("AZC");
  const retaining = await readHandle.createWritable({ keepExistingData: true });
  await retaining.seek(2);
  await retaining.write("!");
  await retaining.close();
  expect(await readFile(join(directory, "record"), "utf8")).toBe("AZ!");
});

it("rejects unsafe sizes and command objects without changing previously durable bytes", async () => {
  const root = await nodeOriginFiles(directory)();
  const handle = await root.getFileHandle("record", { create: true });
  const original = await handle.createWritable();
  await original.write("durable");
  await original.close();
  for (const bad of [
    -1,
    0.5,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
    128 * 1024 * 1024 + 1,
  ]) {
    const writer = await handle.createWritable({ keepExistingData: true });
    await expect(writer.seek(bad)).rejects.toThrow();
    await expect(writer.truncate(bad)).rejects.toThrow();
    await writer.abort();
  }
  const commands = await handle.createWritable();
  await expect(
    commands.write({ type: "write", data: "uncommitted" }),
  ).rejects.toThrow();
  await commands.abort();
  expect(await (await handle.getFile()).text()).toBe("durable");
  await expect(handle.createSyncAccessHandle()).rejects.toMatchObject({
    name: "NotSupportedError",
  });
});

it("lists real children, resolves only descendants and enforces native directory removal semantics", async () => {
  const root = await nodeOriginFiles(directory)();
  const nested = await root.getDirectoryHandle("nested", { create: true });
  const file = await nested.getFileHandle("entry", { create: true });
  await root.getFileHandle("visible", { create: true });
  await writeFile(join(directory, "unfinished.tmp"), "pending");
  await symlink(join(directory, "visible"), join(directory, "link"));
  const keys: string[] = [];
  for await (const key of root.keys()) keys.push(key);
  expect(keys.sort()).toEqual(["nested", "visible"]);
  expect(await root.resolve(file)).toEqual(["nested", "entry"]);
  expect(await root.resolve(root)).toEqual([]);
  expect(await nested.resolve(root)).toBeNull();
  expect(await file.isSameEntry(await nested.getFileHandle("entry"))).toBe(
    true,
  );
  expect(await file.isSameEntry(await root.getFileHandle("visible"))).toBe(
    false,
  );
  await expect(root.removeEntry("nested")).rejects.toThrow();
  expect((await file.getFile()).size).toBe(0);
  expect(await nested.resolve(file)).toEqual(["entry"]);
  await root.removeEntry("nested", { recursive: true });
  await expect(root.getDirectoryHandle("nested")).rejects.toMatchObject({
    name: "NotFoundError",
  });
  await expect(root.removeEntry("missing")).rejects.toMatchObject({
    name: "NotFoundError",
  });
});

it("refuses invalid child names and incompatible file/directory entries before opening foreign paths", async () => {
  const root = await nodeOriginFiles(directory)();
  for (const name of ["", ".", "..", "a/b", "a\\b", "bad\0name"]) {
    await expect(
      root.getFileHandle(name, { create: true }),
    ).rejects.toMatchObject({ name: "TypeMismatchError" });
    await expect(
      root.getDirectoryHandle(name, { create: true }),
    ).rejects.toMatchObject({ name: "TypeMismatchError" });
  }
  await mkdir(join(directory, "folder"));
  await writeFile(join(directory, "record"), "bytes");
  await expect(root.getFileHandle("folder")).rejects.toMatchObject({
    name: "TypeMismatchError",
  });
  await expect(root.getDirectoryHandle("record")).rejects.toMatchObject({
    name: "TypeMismatchError",
  });
});
