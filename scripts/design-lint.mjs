#!/usr/bin/env node
/**
 * Design lint — the control contract in `docs/design/controls.md`, enforced.
 *
 * The vault has two primary actions: `.go`, the ink square that ends a screen,
 * and `.btn--primary`, the text button that does a thing inside a card. The
 * first-run setup ceremony shipped with a full-width text slab in its foot
 * bar, which is neither — it read as a banner and looked nothing like the
 * unlock screen it sits next to. Review caught it; nothing else would have.
 *
 * So these four checks. They are deliberately mechanical: a lint that tried to
 * decide *in general* whether a button should have been an icon would be wrong
 * constantly. These catch the specific things that actually went wrong.
 *
 *   node scripts/design-lint.mjs [files...]
 *
 * With no arguments it sweeps the UI source. With arguments (the pre-commit
 * and agent-hook path) it checks only those files, skipping any it does not
 * own — so it is cheap enough to run on every edit.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `--root <dir>` re-points the lint at another tree. Only the contract test
 * uses it: it writes deliberately-broken copies of real screens into a temp
 * tree and runs the lint against them, because a lint nobody has watched fail
 * is a lint nobody knows works.
 */
const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const root =
  rootFlag === -1
    ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
    : resolve(argv[rootFlag + 1] ?? ".");
const fileArgs =
  rootFlag === -1
    ? argv
    : argv.filter((_, i) => i !== rootFlag && i !== rootFlag + 1);

/** Where the shared control is defined — the one file allowed to define it. */
const CONTROL_HOME = "apps/pages/src/styles.css";

/** UI trees this lint owns. */
const ROOTS = ["apps/pages/src", "apps/pwa/src", "apps/ceremonies/src"];

const DOC = "docs/design/controls.md";

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|css)$/.test(full)) out.push(full);
  }
  return out;
}

function targets(argv) {
  if (argv.length === 0) {
    const out = [];
    for (const dir of ROOTS) walk(join(root, dir), out);
    return out;
  }
  return argv
    .map((file) => resolve(root, file))
    .filter((file) => {
      if (!/\.(tsx|css)$/.test(file)) return false;
      const rel = relative(root, file);
      return ROOTS.some((dir) => rel.startsWith(dir));
    });
}

const problems = [];

function report(file, line, rule, message) {
  problems.push({ file: relative(root, file), line, rule, message });
}

/** The line number a match falls on, for an editor-clickable location. */
function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/**
 * A screen's commit bar: the `*__foot` of a screen-level ceremony.
 *
 * Scoped to `src/screens/` deliberately. A *card* also has a foot — see
 * `.conn-card__foot` — and a card's foot is legitimately a row of
 * `.btn--primary` actions, because the label is doing real work there ("Renew
 * now", "Re-authorize"). The contract is about the action that ends a
 * *screen*, and in this codebase screens live in one directory.
 */
const COMMIT_BAR = /className="[^"]*\b(\w+__foot)\b[^"]*"/g;
const SCREEN_DIR = /(^|\/)src\/screens\//;

/** The JSX block a commit bar opens, up to its closing tag at the same depth. */
function blockAfter(source, from) {
  // Cheap and good enough: the foot bar is always a short, flat block. Take
  // everything to the next sibling-or-parent close, capped so a malformed file
  // cannot make this quadratic.
  return source.slice(from, from + 2500);
}

function checkTsx(file, source) {
  // 1. No text-labelled primary in a screen's commit bar.
  const isScreen = SCREEN_DIR.test(relative(root, file).replaceAll("\\", "/"));
  for (const match of isScreen ? source.matchAll(COMMIT_BAR) : []) {
    const block = blockAfter(source, match.index ?? 0);
    const offending = block.indexOf("btn--primary");
    if (offending !== -1) {
      report(
        file,
        lineOf(source, (match.index ?? 0) + offending),
        "commit-bar-uses-go",
        `\`${match[1]}\` commits with a text button. A screen's terminal action is the \`.go\` ink square with its verb beside it.`,
      );
    }
  }

  // 3 & 4. Every `.go` names itself, and carries a verb.
  for (const match of source.matchAll(/className="go"/g)) {
    const index = match.index ?? 0;
    // The control's own attributes, up to the end of its open tag.
    const open = source.slice(index, source.indexOf(">", index) + 1);
    if (!open.includes("aria-label")) {
      report(
        file,
        lineOf(source, index),
        "go-needs-name",
        "A `.go` square carries its verb as its accessible name — add `aria-label`.",
      );
    }
    if (!blockAfter(source, index).includes("go-verb")) {
      report(
        file,
        lineOf(source, index),
        "go-needs-verb",
        "A `.go` square is paired with a `.go-verb` beside it; an unlabelled ink square is mystery meat.",
      );
    }
  }
}

function checkCss(file, source) {
  // 2. `.go` is defined once, in styles.css.
  if (relative(root, file) === CONTROL_HOME) return;
  for (const match of source.matchAll(/^\.go(-row|-verb)?\b[^{]*\{/gm)) {
    report(
      file,
      lineOf(source, match.index ?? 0),
      "go-defined-once",
      `The commit control is defined in ${CONTROL_HOME}. A second copy here is how two screens drift into two different squares.`,
    );
  }
}

const files = targets(fileArgs);
for (const file of files) {
  const source = readFileSync(file, "utf8");
  if (file.endsWith(".tsx")) checkTsx(file, source);
  else checkCss(file, source);
}

if (problems.length === 0) {
  console.log(`design-lint: ${files.length} file(s) OK`);
  process.exit(0);
}

for (const problem of problems) {
  console.error(
    `${problem.file}:${problem.line}  ${problem.rule}\n    ${problem.message}`,
  );
}
console.error(`\ndesign-lint: ${problems.length} problem(s). See ${DOC}.`);
process.exit(1);
