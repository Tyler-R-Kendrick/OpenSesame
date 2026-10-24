import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

/** Pin and verify the inspected inode before reading; never reopen its path. */
export function readPinnedFile(path, expected) {
  const flags =
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0);
  const fd = openSync(path, flags);
  try {
    const actual = fstatSync(fd);
    if (
      !actual.isFile() ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino
    )
      throw new Error(`File changed during inspection: ${path}`);
    return { bytes: readFileSync(fd), executable: actual.mode & 0o111 };
  } finally {
    closeSync(fd);
  }
}
