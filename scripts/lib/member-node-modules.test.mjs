import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_FILE, memberNodeModulesPaths } from "./member-node-modules.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("a path into a workspace member's own node_modules", () => {
  it("is found in a config, from the root or from the member", () => {
    expect(
      memberNodeModulesPaths(
        new Map([
          [
            "apps/pages/vite.config.ts",
            'const a = "../../packages/app-core/node_modules/@noble/curves";',
          ],
          ["packages/cli/vitest.config.ts", 'alias: "./node_modules/x"'],
          ["apps/pages/scripts/zod-csp-plugin.mjs", "ok"],
        ]),
      ),
    ).toEqual([
      "apps/pages/vite.config.ts:1",
      "packages/cli/vitest.config.ts:1",
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
          ["apps/pages/src/lib/a.ts", '"packages/x/node_modules/y"'],
        ]),
      ),
    ).toEqual([]);
  });

  it("is in no tracked build or test configuration", () => {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter((path) => CONFIG_FILE.test(path));
    expect(tracked.length).toBeGreaterThan(50);
    const files = new Map(
      tracked.map((path) => [path, readFileSync(`${root}/${path}`, "utf8")]),
    );
    expect(memberNodeModulesPaths(files)).toEqual([]);
  });
});
