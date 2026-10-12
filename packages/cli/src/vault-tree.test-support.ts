import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Every file under the CLI's vault directory, as `path` + content, for leak checks. */
export async function readVaultTree(stateDir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(`${path}\n${await readFile(path, "utf8")}`);
    }
  };
  await walk(join(stateDir, "vault"));
  return out.join("\n");
}
