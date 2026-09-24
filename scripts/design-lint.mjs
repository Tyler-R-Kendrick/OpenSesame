#!/usr/bin/env node
/**
 * Design lint — `DESIGN.md` and `docs/design/controls.md`, enforced.
 *
 * An action that executes is an icon key (`icon-btn`, or `.go` for the action
 * that ends a screen). A verb painted on a button face is a failure. Choice
 * objects (a provider, a mode, a navigation target, the guest road) stay text.
 * Existing word-verb buttons are pinned in `scripts/design-button-baseline.json`
 * and that ledger only falls.
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
import { checkCommitKeys, checkFieldWidths } from "./design-lint-layout.mjs";
import { wordVerbHits } from "./design-lint-verbs.mjs";

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

/**
 * The one file per app that may define `.go`. An app is its own bundle and
 * cannot load another's stylesheet, so each has exactly one home — and a
 * second copy inside an app is still how two screens drift apart.
 */
const GO_HOMES = [CONTROL_HOME, "apps/ceremonies/src/keys.css"];

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
  checkExplainers(file, source);
  checkCommitKeys(file, source, report, lineOf);
  checkWordVerbs(file, source);
  checkStatusPills(file, source);
}

/** Captions that narrate a connector panel instead of showing the row. */
const EXPLAINER =
  /this app is installed|permissions it was granted|repositories it can reach|saved in this app|already saved in this app|no permissions recorded|no repositories returned|no github user or organization|loading github app access|mirrored as a revocable/i;

function checkExplainers(file, source) {
  const path = relative(root, file).replaceAll("\\", "/");
  if (!path.includes("/sections/connections/")) return;
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of code.matchAll(
    /<div className="panel__head">([\s\S]*?)<\/div>/g,
  )) {
    if (!match[1].includes("hint")) continue;
    report(
      file,
      lineOf(source, match.index ?? 0),
      "no-explainer",
      "A panel head is a title. Do not add a caption that explains the section.",
    );
  }
  for (const match of code.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
    if (!EXPLAINER.test(match[1])) continue;
    report(
      file,
      lineOf(source, match.index ?? 0),
      "no-explainer",
      "Explainer copy is a design smell. Show the account, grant, or repo. Do not describe the panel.",
    );
  }
}

const BUTTON_BASELINE = join(
  dirname(fileURLToPath(import.meta.url)),
  "design-button-baseline.json",
);

function isCountRecord(value) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function readButtonBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(BUTTON_BASELINE, "utf8"));
    if (!isCountRecord(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

const buttonBaseline = readButtonBaseline();

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
      `Word-verb buttons fell from ${recorded} to ${hits.length}. Lower ${path} in scripts/design-button-baseline.json.`,
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

function checkStatusPills(file, source) {
  const face =
    /\b(Connected|Needs you|Needs install|Broken|Not enabled|Revoked|Authorized|Disabled|Enabled|inactive|Saved|In use|Did not match|Does not match|Matches|broad|In trash|Will connect|Ready|Instant|SYNTHETIC|connector off|Identity sealed|No identity|locked|Offline|All connected|Nothing needs setup|needs attention|need attention|errors?|chip\.label|VERB_LABEL|note\.label|session\.status|ISSUE_LABEL|stateChip)\b/;
  for (const match of source.matchAll(
    /<(span|p|output|div)\b[^>]*\bchip\b[^>]*>/g,
  )) {
    const start = (match.index ?? 0) + match[0].length;
    const close = source.indexOf(`</${match[1]}>`, start);
    if (close === -1) continue;
    if (!face.test(source.slice(start, close))) continue;
    report(
      file,
      lineOf(source, match.index ?? 0),
      "status-is-symbol",
      "Status is a StatusMark glyph with aria-label and title. Do not paint the word on a chip. See DESIGN.md § Status is a symbol.",
    );
  }
}

function checkCss(file, source) {
  checkDropdowns(file, source);
  // Comments blanked to the same number of lines, so a reported line
  // number still points at the rule.
  checkFieldWidths(
    file,
    source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
      comment.replace(/[^\n]/g, ""),
    ),
    report,
    lineOf,
  );
  // 2. `.go` is defined once per app, in that app's control home.
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
