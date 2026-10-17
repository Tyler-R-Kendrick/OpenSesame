#!/usr/bin/env node
/**
 * Bundle the bridge and @env-spec/parser into one ES module that runs on a
 * bare `node` with no node_modules beside it: the `opensesame-env-parse.mjs`
 * a release kit ships next to the `opensesame` binary, which looks for it
 * there (crates/env-spec/src/node_bridge/script.rs).
 *
 *   node scripts/bundle.mjs [out]   # default dist/opensesame-env-parse.mjs
 *
 * The same esbuild and parser give the same bytes: no minification, no source
 * map, no clock, and module paths in the output's comments are written as they
 * sit under this package's node_modules (symlinks kept, not resolved into the
 * package manager's store). Which esbuild and parser those are is decided by
 * pnpm-lock.yaml; the root pnpm.overrides rewrite esbuild's specifier, so this
 * package's package.json does not pin it. `keepNames` matters: the bridge tells
 * the parser's classes apart by `constructor.name`.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
export const packageDir = join(here, "..");
export const entry = join(packageDir, "bin", "opensesame-env-parse.mjs");
export const defaultOut = join(packageDir, "dist", "opensesame-env-parse.mjs");

/** Writes the bundle to `out` and returns its path. */
export async function bundle(out = defaultOut) {
  const outfile = resolve(out);
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    absWorkingDir: packageDir,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    keepNames: true,
    preserveSymlinks: true,
    minify: false,
    sourcemap: false,
    legalComments: "inline",
    charset: "utf8",
    logLevel: "warning",
  });
  return outfile;
}

function invokedAsScript(script = process.argv[1]) {
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  const written = await bundle(process.argv[2]);
  process.stdout.write(`${written}\n`);
}
