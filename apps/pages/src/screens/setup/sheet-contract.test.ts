import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The sheet rules, watched failing on the sheet that got through.
 *
 * "Reset this browser?" passed every design check and was still a
 * warning-washed card under a title it repeated, a kicker phrased as a
 * question, "Erase everything in this browser" painted across a red slab,
 * and a caption in the foot. Each case below is one piece of that sheet,
 * as it shipped; each must fail the lint by its own rule.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..", "..", "..");
const lint = join(root, "scripts", "quality", "design-lint.mjs");

type LintRun = { code: number; output: string };

function lintOne(contents: string): LintRun {
  const dir = mkdtempSync(join(tmpdir(), "design-lint-sheets-"));
  const file = join(dir, "apps/pages/src/screens/unlock/Broken.tsx");
  execFileSync("mkdir", ["-p", dirname(file)]);
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

/** The reset sheet's body, as it shipped. */
const SHIPPED_CARD = `<CeremonyShell
  ok={false}
  top="Everything this app keeps here"
  name="Reset this browser?"
  facts={[{ key: "Erased", value: "every vault, sign-in and setting" }]}
  primary={{
    label: "Erase everything in this browser",
    tone: "danger",
    busy,
    onClick: erase,
  }}
  secondary={{ label: "Keep it", onClick: onClose }}
/>`;

describe("the sheet that shipped fails design lint", () => {
  it.each([
    [
      "word-slot",
      "a verb passed through a prop onto a text button",
      `<button type="button" className="btn btn--danger" onClick={primary.onClick}>
  {primary.label}
</button>`,
    ],
    [
      "word-slot",
      "a label variable on a form's submit",
      `<button type="submit" className="btn btn--sm btn--primary">{submitLabel}</button>`,
    ],
    [
      "word-verb-button",
      "a verb in front of a template hole",
      `<button type="button" className="btn btn--primary">{busy ? "Checking…" : \`Add \${preset.label}\`}</button>`,
    ],
    [
      "sheet-caption",
      "a caption in the sheet's foot",
      `<div className="sheet__foot">
  <p className="hint">
    Copies outside this browser — a backup, another device — are not touched.
  </p>
</div>`,
    ],
    [
      "sheet-caption",
      "a line under the sheet's title",
      `<div className="sheet__head">
  <div className="sheet__grow">
    <h2>More</h2>
    <p>{summarize(connectors)}</p>
  </div>
</div>`,
    ],
    [
      "sheet-caption",
      "a foot handed to a sheet frame",
      `<CeremonySheet title="Delete a vault" mark={null} foot="Copies outside this browser are not touched." onClose={close}>
  <p>card</p>
</CeremonySheet>`,
    ],
    ["ask-is-not-alarm", "a warning wash on a question", SHIPPED_CARD],
    [
      "top-is-a-fact",
      "a kicker phrased as a question",
      `<CeremonyShell top="Delete this vault?" name={label} />`,
    ],
    [
      "title-said-once",
      "the card naming the sheet again",
      `<div role="dialog" aria-label="Reset this browser?">
  <h2>Reset this browser?</h2>
  ${SHIPPED_CARD}
</div>`,
    ],
  ])("%s: rejects %s", (rule, _, source) => {
    const result = lintOne(`${source}\n`);
    expect(result.code).toBe(1);
    expect(result.output).toContain(rule);
  });
});

describe("the shapes the contract asks for pass", () => {
  it.each([
    [
      "an ask on a plain card, its keys drawn by the shell",
      `<div role="dialog" aria-label="Reset this browser">
  <h2>Reset this browser</h2>
  <CeremonyShell
    name={origin}
    facts={[{ key: "After", value: "a first visit" }]}
    primary={{ label: "Erase this browser", tone: "danger", onClick: erase }}
    secondary={{ label: "Keep it", onClick: onClose }}
  />
</div>`,
    ],
    [
      "a fact as the top line",
      `<CeremonyShell ok top="Enrolled" name="Passkey" />`,
    ],
    [
      "a `.go` square with its verb beside it",
      `<div className="go-row">
  <button type="button" className="go" aria-label={label} title={label}><IconCheck /></button>
  <span className="go-verb" aria-hidden="true">{label}</span>
</div>`,
    ],
    [
      "a provider named as the thing chosen",
      `<button type="button" className="btn choice signin__social">{children}</button>`,
    ],
    [
      "a sheet whose foot is a composer, not a caption",
      `<div className="sheet__foot">
  <SupportComposer query={query} onQueryChange={setQuery} />
</div>`,
    ],
  ])("accepts %s", (_, source) => {
    const result = lintOne(`${source}\n`);
    expect(result.output).not.toMatch(
      /word-slot|word-verb-button|sheet-caption|ask-is-not-alarm|top-is-a-fact|title-said-once/,
    );
  });
});

describe("an entrance that holds its transform fails design lint", () => {
  function lintCss(css: string): LintRun {
    const dir = mkdtempSync(join(tmpdir(), "design-lint-fill-"));
    const file = join(dir, "apps/pages/src/screens/broken.css");
    execFileSync("mkdir", ["-p", dirname(file)]);
    writeFileSync(file, css);
    try {
      const output = execFileSync(
        process.execPath,
        [lint, "--root", dir, file],
        {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, NODE_OPTIONS: "" },
        },
      );
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

  const SETTLE = `@keyframes settle {
  from { opacity: 0; transform: translateY(10px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
@keyframes drain {
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
}
`;

  it("rejects the unlock card's `settle … both`, which trapped the reset sheet", () => {
    const result = lintCss(
      `${SETTLE}.unlock__card {\n  animation: settle 520ms var(--ease) both;\n}\n`,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("animation-lets-go");
    expect(result.output).toContain("broken.css:10");
  });

  it("accepts an entrance that fills backwards, and a countdown held at its end", () => {
    const result = lintCss(
      `${SETTLE}.unlock__card {\n  animation: settle 520ms var(--ease) backwards;\n}\n.bar {\n  animation: drain 1s linear forwards;\n}\n`,
    );
    expect(result.output).not.toContain("animation-lets-go");
  });
});
