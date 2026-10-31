/**
 * Source that names a path inside a workspace member's own node_modules (the
 * member's directory, then `node_modules/<dependency>`) holds only under
 * pnpm's isolated layout. Under a hoisted or nested layout the member has no
 * such directory, and the build, the tool or the harness fails. Such code asks
 * Node's resolution instead (`apps/pages/scripts/lib/dependency-root.mjs`,
 * `tests/mtls-interop/harness/tsx-cli.mjs`).
 */

/** Tracked source that runs: scripts, modules, tests, shell and Rust. */
export const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx|sh|rs)$/;

/**
 * Not source that runs: documentation and fixture trees. Lockfiles have none
 * of the extensions above.
 */
const NOT_SOURCE = /^docs\/|(?:^|\/)fixtures?\//;

/** A path into a member's own node_modules, from the root or from the member. */
const MEMBER_NODE_MODULES =
  /(?:^|[^\w.@-])(?:apps|packages|examples|tools|tests)\/[\w.@-]+\/node_modules\/|["'`]\.\/node_modules\//;

/** Whether `path` is source the scan reads. */
export function scanned(path) {
  return SOURCE_FILE.test(path) && !NOT_SOURCE.test(path);
}

/** Each line of a scanned file of `files` (path → text) that names one. */
export function memberNodeModulesPaths(files) {
  const found = [];
  for (const [path, text] of files) {
    if (!scanned(path)) continue;
    text.split("\n").forEach((line, index) => {
      if (MEMBER_NODE_MODULES.test(line))
        found.push({ at: `${path}:${index + 1}`, path, line: line.trim() });
    });
  }
  return found;
}
