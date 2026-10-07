/** POSIX controlled receiver files: descriptor-bound reads and private durable atomic receipts. */
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
function owner(uid: number): boolean {
  return process.getuid?.() === uid;
}
export async function readPrivateObservationFile(
  path: string,
  max: number,
): Promise<string> {
  if (process.platform === "win32")
    throw new Error("Use a native protected receiver on Windows.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: Buffer | undefined;
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      !owner(info.uid) ||
      (info.mode & 0o077) !== 0 ||
      info.size > max
    )
      throw new Error("Use a bounded private receiver file (mode0600). ");
    raw = Buffer.alloc(max + 1);
    const { bytesRead } = await file.read(raw, 0, raw.length, 0);
    const current = await file.stat();
    if (
      bytesRead > max ||
      bytesRead !== info.size ||
      current.size !== info.size ||
      current.mtimeMs !== info.mtimeMs
    )
      throw new Error("Receiver file changed or exceeds its bound.");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      raw.subarray(0, bytesRead),
    );
  } finally {
    raw?.fill(0);
    await file.close();
  }
}
export type PrivateObservationStateFile = {
  read(): Promise<string>;
  write(raw: string): Promise<void>;
  close(): Promise<void>;
};
type PinnedObservationDirectory = {
  full: string;
  parent: string;
  directory: FileHandle;
  check: () => Promise<void>;
};
async function writeObservationReceipt(
  context: PinnedObservationDirectory,
  raw: string,
): Promise<void> {
  await context.check();
  const pending = resolve(
    context.parent,
    `${basename(context.full)}.pending-${crypto.randomUUID()}`,
  );
  const file = await open(
    pending,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(raw);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await context.check();
    await rename(pending, context.full);
    await context.directory.sync();
    await context.check();
  } catch (error) {
    await unlink(pending).catch(() => {});
    throw error;
  }
}
export async function openPrivateObservationStateFile(
  path: string,
): Promise<PrivateObservationStateFile> {
  if (process.platform === "win32")
    throw new Error("Use a native protected receiver on Windows.");
  const full = resolve(path);
  const parent = dirname(full);
  if ((await realpath(parent)) !== parent)
    throw new Error(
      "Receiver receipt directory must have a direct private path.",
    );
  const directory = await open(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let lease: FileHandle | undefined;
  const leasePath = `${full}.lock`;
  try {
    const original = await directory.stat();
    if (
      !original.isDirectory() ||
      !owner(original.uid) ||
      (original.mode & 0o077) !== 0
    )
      throw new Error(
        "Receiver receipt directory must be private (mode0700). ",
      );
    const check = async () => {
      const current = await lstat(parent);
      if (
        !current.isDirectory() ||
        current.dev !== original.dev ||
        current.ino !== original.ino ||
        !owner(current.uid) ||
        (current.mode & 0o077) !== 0
      )
        throw new Error("Receiver receipt directory changed.");
    };
    lease = await open(
      leasePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await lease.writeFile(JSON.stringify({ v: 1, pid: process.pid }));
    await lease.sync();
    let closed = false;
    return {
      async read() {
        if (closed) throw new Error("Receiver files are closed.");
        await check();
        const raw = await readPrivateObservationFile(full, 1048576);
        await check();
        return raw;
      },
      async write(raw) {
        if (closed || Buffer.byteLength(raw) > 1048576)
          throw new Error("Receiver receipt write is unavailable.");
        await writeObservationReceipt({ full, parent, directory, check }, raw);
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await lease?.close();
          await check();
          await unlink(leasePath);
        } finally {
          await directory.close();
        }
      },
    };
  } catch (error) {
    if (lease) {
      await lease.close();
      await unlink(leasePath).catch(() => {});
    }
    await directory.close();
    throw error;
  }
}
