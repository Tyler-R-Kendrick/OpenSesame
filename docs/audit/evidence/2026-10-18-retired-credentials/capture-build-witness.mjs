import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [repo, artifact, output] = process.argv.slice(2);
const paths = execFileSync("git", ["ls-files", "-z"], { cwd: repo })
  .toString()
  .split("\0")
  .filter(
    (path) =>
      path &&
      /\.(?:ts|tsx|mjs|json|css|html|yaml|yml)$/.test(path) &&
      !path.startsWith("docs/") &&
      !path.startsWith("skills/"),
  );
const source = [];
for (const path of paths) {
  try {
    const bytes = await readFile(join(repo, path));
    source.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } catch {}
}
const untracked = execFileSync(
  "git",
  ["ls-files", "--others", "--exclude-standard", "-z"],
  { cwd: repo },
)
  .toString()
  .split("\0")
  .filter(
    (path) =>
      path &&
      /\.(?:ts|tsx|mjs|json|css|html)$/.test(path) &&
      !path.startsWith("docs/"),
  );
for (const path of untracked) {
  const bytes = await readFile(join(repo, path));
  source.push({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const artifacts = [];
async function scan(dir, prefix = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) await scan(join(dir, entry.name), `${path}/`);
    else if (entry.isFile()) {
      const bytes = await readFile(join(dir, entry.name));
      artifacts.push({
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}
if (artifact !== "-") await scan(artifact);
source.sort((a, b) => a.path.localeCompare(b.path));
artifacts.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(
  output,
  JSON.stringify(
    {
      repo,
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
        .toString()
        .trim(),
      capturedAt: new Date().toISOString(),
      source,
      artifacts,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ source: source.length, artifacts: artifacts.length }),
);
