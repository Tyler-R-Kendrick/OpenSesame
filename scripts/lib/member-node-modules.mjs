/**
 * Configuration that names a path inside a workspace member's own
 * node_modules (`packages/app-core/node_modules/@noble/curves`) holds only
 * under pnpm's isolated layout. Under a hoisted or nested layout the member has
 * no such directory and the build fails. A config resolves the member's copy
 * through Node instead (`apps/pages/scripts/lib/dependency-root.mjs`).
 */

/** Files a build or a test runner reads as configuration. */
export const CONFIG_FILE =
  /(^|\/)((vite|vitest)(\.[\w-]+)?\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|turbo\.json|\.storybook\/main\.[cm]?[jt]s|(playwright|wxt)[^/]*\.config\.[cm]?[jt]s|[\w-]+-plugin\.[cm]?[jt]s)$/;

/** A path into a member's own node_modules, from the root or from the member. */
const MEMBER_NODE_MODULES =
  /(?:^|[^\w.@-])(?:apps|packages|examples|tools|tests)\/[\w.@-]+\/node_modules\/|["'`]\.\/node_modules\//;

/** Each configuration file of `files` (path → text) that hard-codes one, by line. */
export function memberNodeModulesPaths(files) {
  const found = [];
  for (const [path, text] of files) {
    if (!CONFIG_FILE.test(path) || path.includes(".test.")) continue;
    text.split("\n").forEach((line, index) => {
      if (MEMBER_NODE_MODULES.test(line)) found.push(`${path}:${index + 1}`);
    });
  }
  return found;
}
