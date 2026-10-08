import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A control is never red, a sheet has one way out, and a hint is a fact.
 *
 * "Reset this browser" shipped with a red bin on the erase key, a second X
 * beside the erase key ("Keep it") under the close key in the head, and round
 * corners on both. Each case below is one spelling of the first two; each must
 * fail the lint by its own rule, and the plain spellings must not.
 *
 * Every case is a file in one throwaway tree and the lint sweeps that tree
 * once; a case passes or fails by whether the lint named its own file.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..", "..", "..");
const lint = join(root, "scripts", "quality", "design-lint.mjs");

type Case = { rule: string; file: string; why: string; text: string };

const SHOULD_FAIL: readonly Case[] = [
  {
    rule: "no-hint-caption",
    file: "hint-sentence.tsx",
    why: "a sentence of explainer prose under a field",
    text: `export const x = (
  <p className="hint">
    Whole hostname only, case-insensitive. *.example.com matches subdomains.
  </p>
);\n`,
  },
  {
    rule: "no-hint-caption",
    file: "hint-ternary.tsx",
    why: "explainer prose chosen by a ternary inside a hint",
    text: `export const x = (
  <span className="hint">{copied ? "Copied. Add it to your provider." : "Register this exact redirect URI."}</span>
);\n`,
  },
  {
    rule: "no-hint-caption",
    file: "hint-help-property.tsx",
    why: "a definition's help text drawn as a hint",
    text: `export const x = <p className="hint">{field.help}</p>;\n`,
  },
  {
    rule: "no-hint-caption",
    file: "hint-bem.tsx",
    why: "a block-scoped hint carrying a sentence",
    text: `export const x = <p className="account-switcher__hint">This organization has not configured SSO or SAML yet.</p>;\n`,
  },
  {
    rule: "no-hint-caption",
    file: "field-shell-hint.tsx",
    why: "a FieldShell given a hint line",
    text: `export const x = <FieldShell label="Token" value="" hint="Held in this tab only." />;\n`,
  },
  {
    rule: "no-danger-control",
    file: "danger-class.tsx",
    why: "a danger modifier on an icon key",
    text: `export const x = <button type="button" className="icon-btn icon-btn--danger" aria-label="Delete" title="Delete" />;\n`,
  },
  {
    rule: "no-danger-control",
    file: "danger-go.tsx",
    why: "a danger modifier on the terminal square",
    text: `export const x = <button type="button" className="go go--danger" aria-label="Erase" title="Erase" />;\n`,
  },
  {
    rule: "no-danger-control",
    file: "danger-css.css",
    why: "a stylesheet that defines a danger modifier",
    text: ".icon-btn--danger { background: none; }\n",
  },
  {
    rule: "no-control-error-ink",
    file: "go-red.css",
    why: "the terminal square in the error ink",
    text: ".go { background: var(--err); color: var(--err-ink); }\n",
  },
  {
    rule: "no-control-error-ink",
    file: "button-red.css",
    why: "a button's text in the error ink",
    text: ".panel button { color: var(--err); }\n",
  },
  {
    rule: "no-control-error-ink",
    file: "armed-red.css",
    why: "an armed key in the error ink",
    text: ".thing.is-armed { background: var(--err); }\n",
  },
  {
    rule: "no-control-error-ink",
    file: "mic-red.css",
    why: "a mic key held red while it listens",
    text: ".command-bar__mic.is-hot { color: var(--err); background: var(--err-wash); }\n",
  },
  {
    rule: "no-control-error-ink",
    file: "menu-red.css",
    why: "a danger menu entry's hover in the error ink inside a media query",
    text: "@media (hover: hover) {\n  .ctxmenu__item.is-danger:hover { color: var(--err); }\n}\n",
  },
  {
    rule: "one-way-out",
    file: "keep-key.tsx",
    why: "a Keep key beside the erase key",
    text: `export const x = (
  <CeremonyShell
    name="This browser"
    primary={{ label: "Erase this browser", tone: "danger", onClick: erase }}
    secondary={{ label: "Keep it", onClick: onClose }}
  />
);\n`,
  },
  {
    rule: "one-way-out",
    file: "not-now.tsx",
    why: "a Not now key that only leaves",
    text: `export const x = (
  <CeremonyShell
    name="Leave these"
    primary={{ label: "Leave them", onClick: go }}
    secondary={{ label: "Not now", onClick: () => flow.reset() }}
  />
);\n`,
  },
];

const SHOULD_PASS: readonly Case[] = [
  {
    rule: "no-hint-caption",
    file: "hint-fact.tsx",
    why: "a hint that states a dated fact",
    text: `export const x = <span className="hint">Enrolled {date}</span>;\n`,
  },
  {
    rule: "no-hint-caption",
    file: "hint-empty-state.tsx",
    why: "a short empty state",
    text: `export const x = <p className="hint">No receipts yet.</p>;\n`,
  },
  {
    rule: "no-hint-caption",
    file: "hint-data.tsx",
    why: "a hint that is a labelled value",
    text: `export const x = <p className="hint">Callback: {row.redirectUri}</p>;\n`,
  },
  {
    rule: "no-hint-caption",
    file: "field-shell-plain.tsx",
    why: "a FieldShell with no hint",
    text: `export const x = <FieldShell label="Token" value="" />;\n`,
  },
  {
    rule: "no-control-error-ink",
    file: "status-mark.css",
    why: "the status glyph in the error ink",
    text: ".status-mark--err { color: var(--err); }\n",
  },
  {
    rule: "no-control-error-ink",
    file: "tray-card.css",
    why: "the tray card's border in the error ink",
    text: ".notice-card--err { border-color: var(--err); }\n",
  },
  {
    rule: "no-control-error-ink",
    file: "invalid-field.css",
    why: "an invalid field's border",
    text: '.field input[aria-invalid="true"] { border-color: var(--err); }\n',
  },
  {
    rule: "no-control-error-ink",
    file: "plain-go.css",
    why: "the terminal square in ink",
    text: ".go { background: var(--ink); color: var(--canvas); }\n",
  },
  {
    rule: "one-way-out",
    file: "choice-secondary.tsx",
    why: "a secondary that is a real second road",
    text: `export const x = (
  <CeremonyShell
    name="Identity"
    primary={{ label: "Sign in", onClick: signIn }}
    secondary={{ label: "Use this device", choice: true, onClick: connect }}
  />
);\n`,
  },
  {
    rule: "one-way-out",
    file: "no-secondary.tsx",
    why: "the erase key alone",
    text: `export const x = (
  <CeremonyShell
    name="This browser"
    primary={{ label: "Erase this browser", tone: "danger", onClick: erase }}
  />
);\n`,
  },
];

let output = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "design-lint-controls-"));
  const sections = join(dir, "apps/pages/src/sections");
  mkdirSync(sections, { recursive: true });
  for (const item of [...SHOULD_FAIL, ...SHOULD_PASS])
    writeFileSync(join(sections, item.file), item.text);
  try {
    output = execFileSync(process.execPath, [lint, "--root", dir], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "" },
    });
  } catch (error) {
    const failure: { stdout?: string; stderr?: string } = Object(error);
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
});

/** Whether the sweep named `rule` against `file`. */
function flagged(file: string, rule: string): boolean {
  return output
    .split("\n")
    .some(
      (line) =>
        line.startsWith(`apps/pages/src/sections/${file}:`) &&
        line.includes(rule),
    );
}

describe("a red control, a second way out or a hint caption fails design lint", () => {
  it.each(SHOULD_FAIL.map((item) => [item.why, item] as const))(
    "rejects %s",
    (_, item) => {
      expect(flagged(item.file, item.rule)).toBe(true);
    },
  );

  it.each(SHOULD_PASS.map((item) => [item.why, item] as const))(
    "accepts %s",
    (_, item) => {
      expect(flagged(item.file, item.rule)).toBe(false);
    },
  );
});
