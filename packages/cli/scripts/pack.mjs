/** Package the bundled CLI without unresolved workspace runtime dependencies. */
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const stage = await mkdtemp(join(tmpdir(), "opensesame-cli-package-"));
try {
  await cp(join(root, "dist"), join(stage, "dist"), { recursive: true });
  await cp(join(root, "README.md"), join(stage, "README.md"));
  await writeFile(
    join(stage, "package.json"),
    `${JSON.stringify({ name: manifest.name, version: manifest.version, type: "module", description: manifest.description, bin: manifest.bin, exports: manifest.exports, files: ["dist"], engines: { node: ">=22" }, dependencies: { "@types/node": manifest.devDependencies["@types/node"], "agent-browser": manifest.dependencies["agent-browser"] } }, null, 2)}\n`,
  );
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", root],
    { cwd: stage, stdio: "inherit" },
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
