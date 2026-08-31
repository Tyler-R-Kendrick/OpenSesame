import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The control contract, tested on the lint that enforces it.
 *
 * `docs/design/controls.md` names two primary actions and says which is which.
 * The setup ceremony shipped with the wrong one — a full-width text slab where
 * the screen's terminal commit belongs — and no gate caught it. This pins both
 * halves: that the shipped screens satisfy the contract, and that the lint
 * would actually fail on the exact code that got through.
 *
 * A lint nobody has watched fail is a lint nobody knows works.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..", "..", "..");
const lint = join(root, "scripts", "design-lint.mjs");

type LintResult = { code: number; output: string };

function runLint(...files: string[]): LintResult {
  try {
    const output = execFileSync(process.execPath, [lint, ...files], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // The hook path clears this for the same reason: an inherited
      // `--import` flag makes every node invocation fail confusingly.
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

/**
 * A throwaway tree holding one deliberately-broken file, at the path the lint
 * cares about. Returns the args that point the lint at it.
 */
function brokenTree(name: string, contents: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "design-lint-"));
  const file = join(dir, "apps", "pages", "src", "screens", name);
  execFileSync("mkdir", ["-p", dirname(file)]);
  writeFileSync(file, contents);
  return ["--root", dir, file];
}

/** A copy of a real screen, edited to break exactly one rule. */
function withEdit(relPath: string, edit: (source: string) => string): string[] {
  const source = readFileSync(join(root, relPath), "utf8");
  return brokenTree("Broken.tsx", edit(source));
}

describe("the shipped screens satisfy the control contract", () => {
  it("passes a full sweep", () => {
    const result = runLint();
    expect(result.output).toContain("OK");
    expect(result.code).toBe(0);
  });
});

describe("the lint fails on the code that actually got through", () => {
  it("rejects a text button in a screen's commit bar", () => {
    // Verbatim the shape that shipped: a wide `btn--primary` in `setup__foot`.
    const broken = withEdit(
      "apps/pages/src/screens/SetupScreen.tsx",
      (source) =>
        source.replace(
          /<div className="go-row">[\s\S]*?<\/div>/,
          '<button type="button" className="btn btn--primary">{verb}</button>',
        ),
    );
    const result = runLint(...broken);
    expect(result.code).toBe(1);
    expect(result.output).toContain("commit-bar-uses-go");
  });

  it("rejects a `.go` square with no accessible name", () => {
    const broken = withEdit(
      "apps/pages/src/screens/SetupScreen.tsx",
      (source) => source.replace("aria-label={verb}", ""),
    );
    const result = runLint(...broken);
    expect(result.code).toBe(1);
    expect(result.output).toContain("go-needs-name");
  });

  it("rejects a `.go` square with no verb beside it", () => {
    const broken = withEdit(
      "apps/pages/src/screens/SetupScreen.tsx",
      (source) =>
        source.replace(/<span className="go-verb"[\s\S]*?<\/span>/, ""),
    );
    const result = runLint(...broken);
    expect(result.code).toBe(1);
    expect(result.output).toContain("go-needs-verb");
  });

  it("rejects a second definition of the commit control", () => {
    const broken = brokenTree(
      "drift.css",
      ".go {\n  background: hotpink;\n}\n",
    );
    const result = runLint(...broken);
    expect(result.code).toBe(1);
    expect(result.output).toContain("go-defined-once");
  });
});

describe("the lint leaves in-card actions alone", () => {
  it("accepts `.btn--primary` in a card's foot", () => {
    // `conn-card__foot` is a row of card actions whose labels do real work
    // ("Renew now", "Re-authorize"). Flagging those would make the lint noise.
    const result = runLint(
      "apps/pages/src/sections/connections/ConnectionCard.tsx",
    );
    expect(result.code).toBe(0);
  });
});
