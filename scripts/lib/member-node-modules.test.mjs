import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { memberNodeModulesPaths, scanned } from "./member-node-modules.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Lines that name a member's node_modules and do not depend on how this
 * checkout was installed. Each names the file, the text and why.
 */
const ALLOWED = [
  {
    path: "scripts/lib/member-node-modules.test.mjs",
    text: "node_modules/",
    reason: "the examples below are the paths this rule refuses",
  },
  {
    path: "scripts/lib/log-hygiene.test.mjs",
    text: '"packages/a/node_modules/x/src/y.js"',
    reason: "a path string the log-hygiene walker must skip; nothing opens it",
  },
  {
    path: "apps/pages/scripts/kdbx-native-dom-plugin.test.mjs",
    text: '"packages/app-core/node_modules/kdbxweb"',
    reason:
      "builds that layout in a temporary directory, to show a replaced SDK is refused",
  },
  {
    path: "apps/pages/scripts/lib/round8-profile-trees.test.mjs",
    text: '"packages/one/node_modules/inner/node_modules"',
    reason: "a temporary tree that shows only the outer node_modules is listed",
  },
  {
    path: "apps/pages/scripts/lib/round8-profile-trees.test.mjs",
    text: '"apps/pages/node_modules/@opensesame/app-core"',
    reason:
      "the isolated layout, built in a temporary directory, is mirrored too",
  },
  {
    path: "packages/agent-sandboxes/src/boat-agent.ts",
    text: "packages/cua-password-reset/node_modules/.bin/agent-browser",
    reason:
      "runs inside a remote sandbox after the same script's `pnpm install --frozen-lockfile`, which makes that layout; never against this checkout",
  },
  {
    path: "packages/agent-sandboxes/src/boat-agent.test.ts",
    text: '"./node_modules/.bin/tsx"',
    reason: "asserts the sandbox bootstrap command above",
  },
];

const allowed = (finding) =>
  ALLOWED.some(
    (entry) => entry.path === finding.path && finding.line.includes(entry.text),
  );

describe("a path into a workspace member's own node_modules", () => {
  it("is found in source, from the root or from the member", () => {
    expect(
      memberNodeModulesPaths(
        new Map([
          [
            "apps/pages/vite.config.ts",
            'const a = "../../packages/app-core/node_modules/@noble/curves";',
          ],
          ["packages/cli/vitest.config.ts", 'alias: "./node_modules/x"'],
          [
            "tests/mtls-interop/tests/support/identity.rs",
            'root.join("packages/control-plane/node_modules/.bin/tsx")',
          ],
          ["scripts/run.sh", "exec apps/pages/node_modules/.bin/vite"],
        ]),
      ).map((finding) => finding.at),
    ).toEqual([
      "apps/pages/vite.config.ts:1",
      "packages/cli/vitest.config.ts:1",
      "tests/mtls-interop/tests/support/identity.rs:1",
      "scripts/run.sh:1",
    ]);
  });

  it("is not a suffix any layout's path ends with", () => {
    expect(
      memberNodeModulesPaths(
        new Map([
          [
            "apps/pages/scripts/zod-csp-plugin.mjs",
            'path.endsWith("/node_modules/zod/v4/core/core.js")',
          ],
        ]),
      ),
    ).toEqual([]);
  });

  it("is not looked for in documentation or fixture trees", () => {
    expect(scanned("docs/contributing/commands.md")).toBe(false);
    expect(scanned("docs/evidence/x/capture.mjs")).toBe(false);
    expect(scanned("tests/fixtures/tree/index.js")).toBe(false);
    expect(scanned("apps/pages/scripts/lib/unlock-flow.mjs")).toBe(true);
    expect(scanned("tests/mtls-interop/src/node.rs")).toBe(true);
  });

  it("is in no tracked source that runs, beyond the lines allowed above", () => {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(scanned);
    expect(tracked.length).toBeGreaterThan(5000);
    const files = new Map(
      tracked.map((path) => [path, readFileSync(`${root}/${path}`, "utf8")]),
    );
    const found = memberNodeModulesPaths(files);
    expect(found.filter((finding) => !allowed(finding))).toEqual([]);
    // An allowance with nothing left to allow is removed, not kept.
    for (const entry of ALLOWED)
      expect(
        found.some(
          (finding) =>
            finding.path === entry.path && finding.line.includes(entry.text),
        ),
        `${entry.path}: ${entry.text}`,
      ).toBe(true);
  });
});
