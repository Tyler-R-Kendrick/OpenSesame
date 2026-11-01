// Builds Pages for CD browser qualification from its package build recipe.
// Standalone typechecking runs in Git hooks; production compilation stays here.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRootFromHere } from "./ci-changed-areas.mjs";
import { isString } from "./json-boundary.mjs";

/** The steps of a `&&` chain, without the typecheck. */
export function buildSteps(script) {
  return script
    .split("&&")
    .map((step) => step.trim())
    .filter((step) => step !== "" && step !== "tsc --noEmit");
}

function main() {
  const dir = join(repoRootFromHere(), "apps/pages");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const script = pkg.scripts?.build;
  if (!isString(script)) {
    console.error("apps/pages has no build script");
    process.exit(1);
  }
  for (const step of buildSteps(script)) {
    console.error(`> ${step}`);
    const words = step.split(/\s+/);
    // `node scripts/...` runs as written; a bin (`vite build`) resolves through
    // the package's own node_modules, as it does under `npm exec`.
    const [command, args] =
      words[0] === "node"
        ? ["node", words.slice(1)]
        : ["npm", ["exec", "--", ...words]];
    const result = spawnSync(command, args, {
      cwd: dir,
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) {
      console.error(result.error.message);
      process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

const invoked =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
