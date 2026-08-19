import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const eveRoot = join(here, "../../../apps/eve-deepsec");

describe("PACT — eve-deepsec stay-off paid Gateway", () => {
  it("property: GLM 5.2 is pinned to blackbox", () => {
    const src = readFileSync(join(eveRoot, "agent/agent.ts"), "utf8");
    expect(src).toContain('model: "zai/glm-5.2"');
    expect(src).toContain('only: ["blackbox"]');
    expect(src).toContain('order: ["blackbox"]');
  });

  it("adversarial: deepsec process/sandbox are refused before spawn", () => {
    assertSourceOrder(
      readFileSync(join(eveRoot, "agent/lib/deepsec.ts"), "utf8"),
      [
        'const blocked = args.find((a) => a === "process" || a === "sandbox")',
        "refused: do not run deepsec process/sandbox",
        'spawn("pnpm", ["deepsec", ...args]',
      ],
    );
  });

  it("chaos: missing .deepsec install fails closed instead of paying Pi", () => {
    const src = readFileSync(join(eveRoot, "agent/lib/deepsec.ts"), "utf8");
    expect(src).toContain("deepsec not installed");
    expect(src).toContain("deepsecReady()");
  });

  it("adversarial: repository tools reject traversal and symlink escapes", () => {
    const paths = readFileSync(join(eveRoot, "agent/lib/paths.ts"), "utf8");
    expect(paths).toContain("realpathSync(resolved)");
    expect(paths).toContain("relative(canonicalRoot, canonical)");

    assertSourceOrder(
      readFileSync(join(eveRoot, "agent/tools/repo_grep.ts"), "utf8"),
      ["assertRepoFile(path)", "args.push(searchPath)"],
    );
  });

  it("contract: the app stays out of the pnpm workspace", () => {
    const readme = readFileSync(join(eveRoot, "README.md"), "utf8");
    expect(readme).toMatch(/not.*in the pnpm workspace/);
    const workspace = readFileSync(
      join(here, "../../../pnpm-workspace.yaml"),
      "utf8",
    );
    expect(workspace).not.toContain("eve-deepsec");
  });
});
