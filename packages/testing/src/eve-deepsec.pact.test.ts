import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceOrder } from "@opensesame/testing";

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

  it("contract: the app stays out of the pnpm workspace", () => {
    const readme = readFileSync(join(eveRoot, "README.md"), "utf8");
    expect(readme).toMatch(/not.*in the pnpm workspace/);
    const workspace = readFileSync(join(here, "../../../pnpm-workspace.yaml"), "utf8");
    expect(workspace).not.toContain("eve-deepsec");
  });
});
