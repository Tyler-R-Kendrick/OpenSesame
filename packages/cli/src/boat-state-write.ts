import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Internal durability seam: the production caller always supplies fsyncSync. */
export function writeBoatStateAtomically(
  dir: string,
  path: string,
  serialized: string,
  syncFile: (fd: number) => void,
): void {
  const temp = join(
    dir,
    `.boat-agent-state.${randomBytes(16).toString("hex")}.tmp`,
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
    syncFile(fd);
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
