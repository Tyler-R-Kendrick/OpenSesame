import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * DESIGN.md § Shapes: there are no round corners. The rule resolves a radius
 * to pixels before it judges it, so these are the spellings that matter: the
 * ones that draw a pill or a disc however they are written, and the ones that
 * are sharp however they are written.
 *
 * Every case is a file in one throwaway tree and the lint sweeps that tree
 * once, because a process per case is what made this suite slow when CI runs
 * the whole workspace at once. A case passes or fails by whether the lint
 * named its own file.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..", "..", "..");
const lint = join(root, "scripts", "quality", "design-lint.mjs");

const css = (declaration: string) => `.thing { ${declaration} }\n`;

const ROUND: readonly (readonly [string, string])[] = [
  ["a circle", "border-radius: 50%;"],
  ["a pill", "border-radius: 999px;"],
  ["the retired pill token", "border-radius: var(--radius-pill);"],
  ["the old two-pixel scale", "border-radius: 2px;"],
  ["one pixel", "border-radius: 1px;"],
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
];

const SHARP: readonly (readonly [string, string])[] = [
  ["none", "border-radius: 0;"],
  ["zero pixels", "border-radius: 0px;"],
  ["the radius token, which is zero", "border-radius: var(--radius);"],
  ["the large token, which is zero too", "border-radius: var(--radius-lg);"],
  ["a calc that comes to nothing", "border-radius: calc(var(--radius) - 2px);"],
  ["two sharp corners", "border-radius: var(--radius) var(--radius) 0 0;"],
  ["a longhand at zero", "border-top-left-radius: 0;"],
  ["inheriting", "border-radius: inherit;"],
];

/** The files in the tree, by the name each case is written under. */
const FILES = new Map<string, string>();
const caseFile = (kind: string, at: number) => `${kind}-${at}.css`;
ROUND.forEach(([, declaration], at) => {
  FILES.set(caseFile("round", at), css(declaration));
});
SHARP.forEach(([, declaration], at) => {
  FILES.set(caseFile("sharp", at), css(declaration));
});
FILES.set(
  "inline.tsx",
  `export const x = <div style={{ borderRadius: "50%" }} />;\n`,
);
FILES.set(
  "commented.css",
  `/* was border-radius: 50%; */\n${css("border-radius: 0;")}`,
);

/** What one sweep of the tree said: its exit code and the files it named. */
let code = 0;
let output = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "design-lint-shape-"));
  const sections = join(dir, "apps/pages/src/sections");
  mkdirSync(sections, { recursive: true });
  for (const [name, contents] of FILES)
    writeFileSync(join(sections, name), contents);
  try {
    output = execFileSync(process.execPath, [lint, "--root", dir], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    code = 0;
  } catch (error) {
    const failure: { status?: number; stdout?: string; stderr?: string } =
      Object(error);
    code = failure.status ?? 1;
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
});

/** Whether the sweep reported a round corner in `file`. */
function flagged(file: string): boolean {
  return output
    .split("\n")
    .some(
      (line) =>
        line.startsWith(`apps/pages/src/sections/${file}:`) &&
        line.includes("no-round-corners"),
    );
}

describe("round corners fail design lint", () => {
  it("fails the sweep, and names the rule", () => {
    expect(code).toBe(1);
    expect(output).toContain("no-round-corners");
  });

  it.each(ROUND.map(([name], at) => [name, at] as const))(
    "rejects %s",
    (_, at) => {
      expect(flagged(caseFile("round", at))).toBe(true);
    },
  );

  it("rejects a round corner in an inline style, too", () => {
    expect(flagged("inline.tsx")).toBe(true);
  });

  it.each(SHARP.map(([name], at) => [name, at] as const))(
    "accepts %s",
    (_, at) => {
      expect(flagged(caseFile("sharp", at))).toBe(false);
    },
  );

  it("ignores a corner that is only described in a comment", () => {
    expect(flagged("commented.css")).toBe(false);
  });

  it("names nothing but the cases written to be round", () => {
    const named = output
      .split("\n")
      .filter((line) => line.includes("no-round-corners"))
      .map((line) => /sections\/([^:]+):/.exec(line)?.[1])
      .sort();
    const expected = [
      ...ROUND.map((_, at) => caseFile("round", at)),
      "inline.tsx",
    ].sort();
    expect(named).toEqual(expected);
  });

  it("knows the radius tokens the way styles.css defines them", () => {
    const styles = readFileSync(
      join(root, "apps/pages/src/styles.css"),
      "utf8",
    );
    expect(styles).toMatch(/--radius:\s*0;/);
    expect(styles).toMatch(/--radius-lg:\s*0;/);
    expect(styles).not.toMatch(/--radius-pill/);
  });

  it("keeps every corner square, with nothing on the ledger", () => {
    const ledger: Record<string, number> = JSON.parse(
      readFileSync(
        join(root, "tools/quality/design-radius-baseline.json"),
        "utf8",
      ),
    );
    expect(ledger).toEqual({});
  });
});
