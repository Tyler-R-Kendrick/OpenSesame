import { constants } from "node:fs";
/** Fixed package-owned native binary. No PATH lookup or remotely supplied executable. */
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export async function nativeCompanionPath(): Promise<string> {
  const name = process.platform === "win32" ? "opensesame.exe" : "opensesame";
  const path = fileURLToPath(
    new URL(
      `./native/${process.platform}-${process.arch}/${name}`,
      import.meta.url,
    ),
  );
  await access(path, constants.X_OK);
  return path;
}
