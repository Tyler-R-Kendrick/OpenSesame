import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DESIGN.md § Shapes: there are no round corners. The rule resolves a radius
 * to pixels before it judges it, so these are the spellings that matter: the
 * ones that draw a pill or a disc however they are written, and the ones that
 * are sharp however they are written.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..", "..", "..");
const lint = join(root, "scripts", "quality", "design-lint.mjs");

type LintRun = { code: number; output: string };

function lintOne(name: string, contents: string): LintRun {
  const dir = mkdtempSync(join(tmpdir(), "design-lint-shape-"));
  const file = join(dir, "apps/pages/src/sections", name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  try {
    const output = execFileSync(process.execPath, [lint, "--root", dir, file], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    return { code: 0, output };
  } catch (error) {
    const failure: { status?: number; stdout?: string; stderr?: string } =
      Object(error);
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

const css = (declaration: string) => `.thing { ${declaration} }\n`;

describe("round corners fail design lint", () => {
  it.each([
    ["a circle", "border-radius: 50%;"],
    ["a pill", "border-radius: 999px;"],
    ["the pill token", "border-radius: var(--radius-pill);"],
    ["a large radius", "border-radius: 8px;"],
    ["rem units", "border-radius: 0.5rem;"],
    ["half the size, in a calc", "border-radius: calc(var(--fab-size) / 2);"],
    ["one corner of four", "border-radius: 0 0 0 6px;"],
    ["a per-corner longhand", "border-top-left-radius: 12px;"],
    ["an elliptical radius", "border-radius: 2px / 50%;"],
    ["a token plus a pixel", "border-radius: calc(var(--radius) + 1px);"],
    ["a value it cannot resolve", "border-radius: var(--mystery);"],
    [
      "a clamp it cannot resolve",
      "border-radius: clamp(0px, 1vw, 8px) !important;",
    ],
  ])("rejects %s", (_, declaration) => {
    const result = lintOne("Rounded.css", css(declaration));
    expect(result.code).toBe(1);
    expect(result.output).toContain("no-round-corners");
  });

  it("rejects a round corner in an inline style, too", () => {
    const result = lintOne(
      "Rounded.tsx",
      `export const x = <div style={{ borderRadius: "50%" }} />;\n`,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("no-round-corners");
  });

  it.each([
    ["none", "border-radius: 0;"],
    ["zero pixels", "border-radius: 0px;"],
    ["the documented scale", "border-radius: 2px;"],
    ["the scale's token", "border-radius: var(--radius);"],
    [
      "the large token, which is the same 2px",
      "border-radius: var(--radius-lg);",
    ],
    [
      "a calc that comes to nothing",
      "border-radius: calc(var(--radius) - 2px);",
    ],
    ["two sharp corners", "border-radius: var(--radius) var(--radius) 0 0;"],
    ["a longhand inside the scale", "border-top-left-radius: 1px;"],
    ["inheriting", "border-radius: inherit;"],
  ])("accepts %s", (_, declaration) => {
    const result = lintOne("Sharp.css", css(declaration));
    expect(result.output).not.toContain("no-round-corners");
    expect(result.code).toBe(0);
  });

  it("ignores a corner that is only described in a comment", () => {
    const result = lintOne(
      "Commented.css",
      `/* was border-radius: 50%; */\n${css("border-radius: 0;")}`,
    );
    expect(result.code).toBe(0);
  });

  it("knows the radius tokens the way styles.css defines them", () => {
    const styles = readFileSync(
      join(root, "apps/pages/src/styles.css"),
      "utf8",
    );
    expect(styles).toMatch(/--radius:\s*2px;/);
    expect(styles).toMatch(/--radius-lg:\s*2px;/);
    expect(styles).toMatch(/--radius-pill:\s*999px;/);
  });

  it("keeps the Add button and its drag area sharp, with nothing on the ledger", () => {
    const ledger: Record<string, number> = JSON.parse(
      readFileSync(
        join(root, "tools/quality/design-radius-baseline.json"),
        "utf8",
      ),
    );
    for (const sheet of ["new-item-fab.css", "add-slide.css"]) {
      expect(ledger[`apps/pages/src/sections/vault/${sheet}`]).toBeUndefined();
    }
  });
});
