import {
  constants,
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Each run owns its temporary namespace; other users cannot plant files in it. */
export function privateTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Keep the diagnostic's published path without following a planted link. */
export function writePrivateSnapshot(file, data) {
  const flags =
    constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd;
  try {
    fd = openSync(file, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    fd = openSync(file, flags);
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (stat.mode & 0o777) !== 0o600
    ) {
      throw new Error("Refusing unsafe diagnostic file");
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Capture and compose are separate commands sharing a private temporary root. */
export function privateSharedTempDir(name) {
  const dir = join(tmpdir(), name);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const fd = openSync(
    dir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isDirectory() ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (stat.mode & 0o777) !== 0o700
    )
      throw new Error("Refusing unsafe shared capture directory");
  } finally {
    closeSync(fd);
  }
  return dir;
}
