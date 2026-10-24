// What belongs to the release kit (ADR 0212): the workflow that builds it on a
// tag, the scripts that workflow runs and the bridge it bundles. No Pages gate
// can see any of them; ci-release-kit.test.mjs pins the workflow and the
// scripts, and the bridge package has its own tests.
const WORKFLOW_AND_SCRIPTS = [
  ".github/workflows/release-kit.yml",
  "scripts/release/kit-archive.sh",
  "scripts/release/tag-check.sh",
];

/** `path` is part of the release kit. */
export function releaseKitPath(path) {
  return (
    WORKFLOW_AND_SCRIPTS.includes(path) ||
    path.startsWith("packages/env-spec-bridge/")
  );
}
