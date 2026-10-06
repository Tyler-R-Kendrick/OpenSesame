import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import type { BoundaryValue } from "@opensesame/os-domain";

export const securityFilePorts = {
  open: (path: string, flags: number): Promise<FileHandle> => open(path, flags),
};
/** A secret-bearing file is never accepted through argv content or exposed in errors. */
export async function readSecurityFile(
  path: string,
  maxBytes = 8192,
): Promise<string> {
  const file = await securityFilePorts.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.size > maxBytes ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    )
      throw new Error(
        "Use a bounded owner-only regular configuration file (mode 0600).",
      );
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maxBytes)
      throw new Error("Configuration exceeds its size limit.");
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}
export async function writeSecurityFile(
  path: string,
  value: BoundaryValue,
): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}
