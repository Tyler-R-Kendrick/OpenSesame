/**
 * tsx's CLI, as the Identity plane resolves it. The harness runs it with Node
 * (`node <cli> <script>`), so it needs no `.bin` shim inside a workspace
 * member's node_modules, which only some installs write. Node's resolution
 * from the package that depends on tsx finds it under any node_modules layout.
 *
 * `node tsx-cli.mjs <repository root>` prints the path, for the Rust harness.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The workspace member whose dependency pins the tsx the harness runs. */
const OWNER = "packages/control-plane/package.json";

export function tsxCli(repoRoot) {
  return createRequire(join(repoRoot, OWNER)).resolve("tsx/cli");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(`${tsxCli(process.argv[2])}\n`);
