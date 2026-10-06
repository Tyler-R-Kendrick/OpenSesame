import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A failure is never drawn in the page — tested on the lint that enforces it.
 *
 * Nearly every page once carried a red error box. The lint only matched the
 * literal `note--err`, so a dynamic `note--${tone}`, a `*__error` paragraph or
 * a bare `role="alert"` walked past it. This pins each of those spellings, and
 * the one that stays legal, against the lint itself.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..", "..", "..");
const lint = join(root, "scripts", "quality", "design-lint.mjs");

function runLint(file: string, contents: string) {
  const dir = mkdtempSync(join(tmpdir(), "failure-lint-"));
  const path = join(dir, "apps", "pages", "src", "sections", file);
  execFileSync("mkdir", ["-p", dirname(path)]);
  writeFileSync(path, contents);
  try {
    const output = execFileSync(process.execPath, [lint, "--root", dir, path], {
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

describe("a clean file passes", () => {
  it("reports nothing", () => {
    const result = runLint("Clean.tsx", "export const A = () => null;\n");
    expect(result.code).toBe(0);
  });
});

describe("the lint refuses every spelling of an in-page failure", () => {
  it.each([
    ["the literal error box", '<p className="note note--err">{error}</p>'],
    [
      "a dynamic tone",
      "<output className={`note note--${flash.tone}`}>x</output>",
    ],
    ["a role=alert paragraph", '<p role="alert">{error}</p>'],
    ["role=alert after the class", '<p className="hint" role="alert">{e}</p>'],
    ["a component given role=alert", '<Banner role="alert">{e}</Banner>'],
    ["a __error paragraph", '<p className="identifier__error">{e}</p>'],
    ["a __err paragraph", '<p className="cfg-source__err">{e}</p>'],
    ["a -error block", '<div className="form-error">{e}</div>'],
    [
      "a broker error card",
      '<div className="broker__card broker__card--err">x</div>',
    ],
    ["a connections flash", '<output className="note conn-flash">x</output>'],
    ["a connections error", '<div className="note conn-error">x</div>'],
  ])("rejects %s", (_name, markup) => {
    const result = runLint(
      "Broken.tsx",
      `export const A = () => (${markup});\n`,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("no-in-page-error");
  });

  it("rejects a multi-line role=alert", () => {
    const result = runLint(
      "Broken.tsx",
      'export const A = () => (\n  <p\n    className="hint"\n    role="alert"\n  >\n    {e}\n  </p>\n);\n',
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("no-in-page-error");
  });

  it.each([
    [
      "an inline arrow before role",
      '<button onClick={() => go()} role="alert">{e}</button>',
    ],
    [
      "a comparison before role",
      '<p title={a > b ? "x" : "y"} role="alert">{e}</p>',
    ],
    ["role in braces", '<p role={"alert"}>{e}</p>'],
    ["role in single quotes in braces", "<p role={'alert'}>{e}</p>"],
    ["role in single quotes", "<p role='alert'>{e}</p>"],
    [
      "a visually-hidden class on a different element",
      '<span className="visually-hidden">x</span><p role="alert">{e}</p>',
    ],
  ])("rejects a visible alert with %s", (_name, markup) => {
    const result = runLint(
      "Broken.tsx",
      `export const A = () => (<>${markup}</>);\n`,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("no-in-page-error");
  });

  it("rejects a failing class after a // inside a string on the same line", () => {
    const result = runLint(
      "Broken.tsx",
      'export const A = () => <a href="//cdn.example/x" className="form-error">{e}</a>;\n',
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("no-in-page-error");
  });

  it("rejects a failing rule after a // inside a CSS string", () => {
    const result = runLint(
      "../broken.css",
      '.a { content: "//"; } .thing__error { color: var(--err); }\n',
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("no-error-box-css");
  });

  it("allows a visually-hidden alert after an arrow", () => {
    const result = runLint(
      "Quiet.tsx",
      'export const A = () => <span onClick={() => go()} role="alert" className="visually-hidden">{e}</span>;\n',
    );
    expect(result.code).toBe(0);
  });

  it("allows a visually-hidden alert whose class comes first", () => {
    const result = runLint(
      "Quiet.tsx",
      'export const A = () => <span className="visually-hidden" role={"alert"}>{e}</span>;\n',
    );
    expect(result.code).toBe(0);
  });

  it("allows a visually-hidden live region, which draws nothing", () => {
    const result = runLint(
      "Quiet.tsx",
      'export const A = () => <span role="alert" className="visually-hidden">{e}</span>;\n',
    );
    expect(result.code).toBe(0);
  });

  it("allows the notice seam", () => {
    const result = runLint(
      "Seam.tsx",
      'export const A = () => <FailureNotice id="a:b" title="B" message={e} />;\n',
    );
    expect(result.code).toBe(0);
  });

  it("ignores a failure class mentioned only in a comment", () => {
    const result = runLint(
      "Commented.tsx",
      '// was <p className="note note--err" role="alert">\nexport const A = () => null;\n',
    );
    expect(result.code).toBe(0);
  });
});

describe("the lint refuses CSS that paints a failure into the page", () => {
  it.each([
    [".note--err { background: var(--err-wash); }"],
    [".thing__error { color: var(--err); }"],
    [
      ".panel-alert { background: var(--err-wash); border: 1px solid var(--err); }",
    ],
    [".conn-flash { padding: 0; }"],
  ])("rejects %s", (rule) => {
    const result = runLint("../broken.css", `${rule}\n`);
    expect(result.code).toBe(1);
    expect(result.output).toContain("no-error-box-css");
  });

  it.each([
    [".notice-card--err { border-color: var(--err); }"],
    [".status-mark--err { color: var(--err); }"],
    ['.field input[aria-invalid="true"] { border-color: var(--err); }'],
  ])("allows %s", (rule) => {
    const result = runLint("../fine.css", `${rule}\n`);
    expect(result.code).toBe(0);
  });
});
