#!/usr/bin/env node
/**
 * Design lint — `DESIGN.md` and `docs/design/controls.md`, enforced.
 *
 * An action that executes is an icon key (`icon-btn`, or `.go` for the action
 * that ends a screen). A verb painted on a button face is a failure. Choice
 * objects (a provider, a mode, a navigation target, the guest road) stay text.
 * Existing word-verb buttons are pinned in `tools/quality/design-button-baseline.json`
 * and that ledger only falls.
 *
 *   node scripts/quality/design-lint.mjs [files...]
 *
 * With no arguments it sweeps the UI source. With arguments (the pre-commit
 * and agent-hook path) it checks only those files, skipping any it does not
 * own — so it is cheap enough to run on every edit.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCopy } from "./design-lint-copy.mjs";
import { checkCorners } from "./design-lint-corners.mjs";
import { checkCommitKeys, checkFieldWidths } from "./design-lint-layout.mjs";
import { checkSheets } from "./design-lint-sheets.mjs";
import { wordVerbHits } from "./design-lint-verbs.mjs";
import { checkProse } from "./prose-lint.mjs";

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
    ? resolve(dirname(fileURLToPath(import.meta.url)), "../..")
    : resolve(argv[rootFlag + 1] ?? ".");
const fileArgs =
  rootFlag === -1
    ? argv
    : argv.filter((_, i) => i !== rootFlag && i !== rootFlag + 1);

/** Where the shared control is defined — the one file allowed to define it. */
const CONTROL_HOME = "apps/pages/src/styles.css";

/**
 * The one file per app that may define `.go`. An app is its own bundle and
 * cannot load another's stylesheet, so each has exactly one home — and a
 * second copy inside an app is still how two screens drift apart.
 */
const GO_HOMES = [CONTROL_HOME];

/** UI trees this lint owns. */
const ROOTS = ["apps/pages/src"];

const DOC = "docs/design/controls.md";

/**
 * A spec is not UI: its fixtures deliberately break the rules the
 * lint enforces, so a sweep that read them would fail on its own
 * tests. The contract test pins the lint by writing broken copies
 * to a throwaway tree; the real tree's specs stay out of it.
 */
function isSpec(path) {
  return /\.test\.(tsx|ts|css)$/.test(path);
}

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
    else if (/\.(tsx|ts|css)$/.test(full) && !isSpec(full)) out.push(full);
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
      if (!/\.(tsx|ts|css)$/.test(file) || isSpec(file)) return false;
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
 * `.conn-card__foot`. A card's actions are icon keys too. This check is only
 * about a screen's terminal commit, and screens live in one directory.
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
  // Vault pane commands never become text CTAs when the list is empty.
  const path = relative(root, file).replaceAll("\\", "/");
  if (/\/sections\/(VaultSection|vault\/VaultPathbar)\.tsx$/.test(path)) {
    for (const match of source.matchAll(/["']btn(?:\s|["']|--)/g)) {
      report(
        file,
        lineOf(source, match.index),
        "vault-commands-use-icons",
        "Vault commands belong in the persistent top path strip as named icon keys, never text-button empty-state actions.",
      );
    }
  }
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
  checkCopy(root, file, source, report, lineOf);
  checkCommitKeys(file, source, report, lineOf);
  checkSheets(file, source, report, lineOf);
  checkWordVerbs(file, source);
  checkCorners(path, source, report, lineOf, file);
}

const BUTTON_BASELINE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
  "tools",
  "quality",
  "design-button-baseline.json",
);

function isCountRecord(value) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function readCountBaseline(location) {
  try {
    const parsed = JSON.parse(readFileSync(location, "utf8"));
    if (!isCountRecord(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

const buttonBaseline = readCountBaseline(BUTTON_BASELINE);

function checkWordVerbs(file, source) {
  const path = relative(root, file).replaceAll("\\", "/");
  const hits = wordVerbHits(source);
  const recorded = Object.hasOwn(buttonBaseline, path)
    ? buttonBaseline[path]
    : 0;
  if (!Number.isInteger(recorded)) return;
  if (hits.length === recorded) return;
  if (hits.length < recorded) {
    report(
      file,
      1,
      "word-verb-button",
      `Word-verb buttons fell from ${recorded} to ${hits.length}. Lower ${path} in tools/quality/design-button-baseline.json.`,
    );
    return;
  }
  for (const index of hits.slice(recorded)) {
    report(
      file,
      lineOf(source, index),
      "word-verb-button",
      "An executing action is an icon key (`icon-btn` or `.go`) with aria-label and title. Do not paint the verb on the button. See DESIGN.md § Actions are symbols.",
    );
  }
}

/** Comments blanked to spaces, so every offset still points at its rule. */
function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
}

let entrances;

/** Every `@keyframes` in the UI whose last frame is `transform: none`. */
function entranceKeyframes() {
  if (entrances) return entrances;
  entrances = new Set();
  const sheets = [];
  for (const dir of ROOTS) walk(join(root, dir), sheets);
  for (const sheet of sheets.filter((path) => path.endsWith(".css"))) {
    const css = blankComments(readFileSync(sheet, "utf8"));
    for (const frames of css.matchAll(
      /@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g,
    )) {
      const last = /(?:\bto|100%)\s*\{([^{}]*)\}/.exec(frames[2]);
      if (last && /transform\s*:\s*none/.test(last[1])) {
        entrances.add(frames[1]);
      }
    }
  }
  return entrances;
}

function checkCss(file, source) {
  checkDropdowns(file, source);
  const path = relative(root, file).replaceAll("\\", "/");
  checkCorners(path, blankComments(source), report, lineOf, file);
  // Comments blanked to the same number of lines, so a reported line
  // number still points at the rule.
  checkFieldWidths(file, blankComments(source), report, lineOf);
  // 2. Sentence case everywhere (DESIGN.md § Overview): case is written in
  //    the string, never forced by a rule, so no label turns to capitals.
  for (const match of blankComments(source).matchAll(
    /text-transform\s*:\s*(uppercase|capitalize)\b/g,
  )) {
    report(
      file,
      lineOf(source, match.index ?? 0),
      "sentence-case",
      "Sentence case everywhere: write the label's case in its string, never text-transform it. See DESIGN.md § Overview.",
    );
  }
  // A held animation fill keeps the last keyframe's transform applied, and
  // a transformed element is the containing block of every `position:
  // fixed` descendant: the unlock card's `settle … both` caught the reset
  // sheet inside the card, under its release notes, with a scrollbar of its
  // own. An entrance (one that ends at `transform: none`) gains nothing by
  // holding its last frame, so it fills `backwards`, which looks the same and
  // lets go. A countdown that must stay at its end (`kb-drain`) is not one.
  for (const match of blankComments(source).matchAll(
    /animation(?:-name)?\s*:([^;{}]*)\b(both|forwards)\b/g,
  )) {
    const names = match[1].split(/[\s,]+/);
    if (!names.some((name) => entranceKeyframes().has(name))) continue;
    report(
      file,
      lineOf(source, match.index ?? 0),
      "animation-lets-go",
      `An entrance that fills \`${match[2]}\` holds its transform after it ends, and traps every fixed sheet inside the element. Fill \`backwards\`.`,
    );
  }
  // 3. `.go` is defined once per app, in that app's control home.
  if (GO_HOMES.includes(relative(root, file))) return;
  for (const match of source.matchAll(/^\.go(-row|-verb)?\b[^{]*\{/gm)) {
    report(
      file,
      lineOf(source, match.index ?? 0),
      "go-defined-once",
      `The commit control is defined once per app (${GO_HOMES.join(", ")}). A second copy here is how two screens drift into two different squares.`,
    );
  }
}

function checkDropdowns(file, source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  if (
    relative(root, file) === CONTROL_HOME &&
    !css.includes('@import "./native-controls.css";')
  ) {
    report(
      file,
      1,
      "dropdown-popup-theme",
      "Load the shared native dropdown theme.",
    );
  }
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\b(select|option|optgroup)\b/.test(block[1])) continue;
    for (const declaration of block[2].matchAll(
      /(?:^|;)\s*(color|background(?:-color)?)\s*:\s*([^;]+)/g,
    )) {
      const value = declaration[2].trim();
      if (
        /^(var\(--[\w-]+\)|inherit)$/.test(value) ||
        (value === "transparent" && !/\b(option|optgroup)\b/.test(block[1]))
      )
        continue;
      report(
        file,
        lineOf(css, block.index),
        "dropdown-theme-colors",
        "Dropdown colors must use theme tokens, not fixed colors.",
      );
    }
  }
  if (relative(root, file) !== "apps/pages/src/native-controls.css") return;
  for (const selector of ["select option", "select optgroup"]) {
    const themed = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(
      (block) =>
        block[1].split(",").some((part) => part.trim() === selector) &&
        /background-color:\s*var\(--surface\)\s*;/.test(block[2]) &&
        /(?:^|;)\s*color:\s*var\(--ink\)\s*;/.test(block[2]),
    );
    if (!themed)
      report(
        file,
        1,
        "dropdown-popup-theme",
        `${selector} must pair opaque --surface with --ink.`,
      );
  }
}

const files = targets(fileArgs);
for (const file of files) {
  const source = readFileSync(file, "utf8");
  if (file.endsWith(".css")) {
    checkCss(file, source);
  } else if (file.endsWith(".tsx")) {
    checkTsx(file, source);
    checkProse(file, source, report);
  } else {
    // A `.ts` module: its strings are UI copy too — the support
    // pane's every sentence lives in one — but it carries no JSX
    // for the control checks to read.
    checkProse(file, source, report);
  }
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
