/**
 * Owner-only local state files: trusted directory, no-follow opens,
 * `0600` single-link regular files, atomic rename writes. Provider
 * state modules use these so a pre-positioned or swapped file is
 * refused instead of trusted.
 */
import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function secureStateDirectory(directory: string, label: string): string {
  if (process.getuid === undefined || constants.O_NOFOLLOW === undefined)
    throw new Error(
      `${label} state requires POSIX file permission and no-follow support`,
    );
  const resolved = realpathSync(directory);
  let ancestor = dirname(resolved);
  for (;;) {
    const parent = lstatSync(ancestor);
    const trustedOwner = parent.uid === 0 || parent.uid === process.getuid();
    const writable = (parent.mode & 0o022) !== 0;
    const sticky = (parent.mode & 0o1000) !== 0;
    if (!parent.isDirectory() || !trustedOwner || (writable && !sticky))
      throw new Error(
        `${label} state directory has an untrusted or writable non-sticky ancestor`,
      );
    const next = dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  const stat = lstatSync(resolved);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o022) !== 0
  )
    throw new Error(
      `${label} state directory must be owned by the current user and not group/world writable`,
    );
  return resolved;
}

/** Open an existing private state file, or return undefined when absent. */
export function openPrivateStateFile(
  path: string,
  label: string,
  maxBytes: number,
): number | undefined {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > maxBytes
    )
      throw new Error(
        `${label} state file must be a private 0600 regular file owned by the current user`,
      );
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readPrivateStateFile(
  path: string,
  label: string,
  maxBytes: number,
): string | undefined {
  const fd = openPrivateStateFile(path, label, maxBytes);
  if (fd === undefined) return undefined;
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function writePrivateStateAtomically(
  dir: string,
  path: string,
  serialized: string,
  tempPrefix: string,
): void {
  const temp = join(
    dir,
    `${tempPrefix}.${randomBytes(16).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    const dirFd = openSync(dir, constants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}
