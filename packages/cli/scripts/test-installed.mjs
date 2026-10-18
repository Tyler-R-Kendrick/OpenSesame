import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = await mkdtemp(join(tmpdir(), "opensesame-installed-cli-"));
try {
  await cp(join(root, "dist"), join(stage, "dist"), { recursive: true });
  await writeFile(join(stage, "package.json"), '{"type":"module"}\n');
  const help = execFileSync(
    process.execPath,
    [join(stage, "dist/bin.js"), "--help"],
    {
      encoding: "utf8",
      cwd: stage,
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    },
  );
  assert.match(help, /vault retired/);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [join(stage, "dist/bin.js"), "security", "canary", "serve"],
        { encoding: "utf8", cwd: stage, stdio: "pipe" },
      ),
    (error) =>
      error instanceof Error &&
      "stderr" in error &&
      String(error.stderr).includes("requires --pairing and --state"),
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
process.stdout.write(
  "Installed bundled CLI runs with no workspace, tsx, NODE_PATH or development loader.\n",
);
