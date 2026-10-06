/**
 * Design lint, corners — DESIGN.md § Shapes: **no round corners**.
 *
 * Every control, chip, badge, menu and panel is sharp. The documented scale
 * is one step, 2px (`--radius`), and it exists only to keep a focus ring
 * clean; a pill, a circle, a percentage or anything past 2px is a violation.
 *
 * A radius is resolved to pixels before it is judged, so the rule reads what
 * the browser would draw rather than how it was spelled: `var(--radius)` is
 * 2px and passes, `var(--radius-pill)` is 999px and fails, `calc(var(--radius)
 * - 2px)` is nothing and passes, `50%` fails. A value the rule cannot resolve
 * (an unknown custom property, `clamp()`) fails too: sharp has to be provable.
 *
 * Corners that were round before the rule existed are pinned per file in
 * `tools/quality/design-radius-baseline.json`, and that ledger only falls.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The sharp ceiling, in px: DESIGN.md's one documented scale. */
export const SHARP_PX = 2;

/**
 * The radius tokens, as `styles.css` defines them. The contract test reads
 * that file and fails if these drift from it.
 */
export const RADIUS_TOKENS = {
  "--radius": 2,
  "--radius-lg": 2,
  "--radius-pill": 999,
};

const BASELINE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
  "tools",
  "quality",
  "design-radius-baseline.json",
);

/** `border-radius`, a per-corner longhand, or React's `borderRadius`. */
const DECLARATION =
  /(?<![\w-])(?:border-(?:top|bottom|start|end)-(?:left|right|start|end)-radius|border-radius|borderRadius)["']?\s*:\s*([^;{}\n]+)/g;

const KEYWORD = /^(inherit|initial|unset|revert|revert-layer)$/;

/** A number in CSS pixels, or null when it cannot be known statically. */
function evaluate(text) {
  const input = text.trim();
  let at = 0;
  const space = () => {
    while (input[at] === " ") at++;
  };
  const combine = (left, right, op) => {
    if (left === null || right === null) return null;
    if (op === "+") return left + right;
    if (op === "-") return left - right;
    if (op === "*") return left * right;
    return right === 0 ? null : left / right;
  };
  function group() {
    at++;
    const value = sum();
    space();
    if (input[at] !== ")") return null;
    at++;
    return value;
  }
  function atom() {
    space();
    if (input.startsWith("calc(", at)) {
      at += 4;
      return group();
    }
    if (input[at] === "(") return group();
    if (input.startsWith("var(", at)) {
      const end = input.indexOf(")", at);
      if (end === -1) return null;
      const name = input
        .slice(at + 4, end)
        .split(",")[0]
        .trim();
      at = end + 1;
      return Object.hasOwn(RADIUS_TOKENS, name) ? RADIUS_TOKENS[name] : null;
    }
    const number = /^-?(?:\d+\.?\d*|\.\d+)(px|rem|em|%)?/.exec(input.slice(at));
    if (!number) return null;
    at += number[0].length;
    const size = Number.parseFloat(number[0]);
    if (number[1] === "%") return size > 0 ? Number.POSITIVE_INFINITY : 0;
    if (number[1] === "rem" || number[1] === "em") return size * 16;
    return number[1] === "px" || size === 0 ? size : null;
  }
  function product() {
    let value = atom();
    space();
    while (input[at] === "*" || input[at] === "/") {
      const op = input[at++];
      value = combine(value, atom(), op);
      space();
    }
    return value;
  }
  function sum() {
    let value = product();
    space();
    while (input[at] === "+" || input[at] === "-") {
      const op = input[at++];
      value = combine(value, product(), op);
      space();
    }
    return value;
  }
  const value = sum();
  space();
  return at === input.length ? value : null;
}

/** Split on spaces and `/` that sit outside every parenthesis. */
function components(value) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth === 0 && (char === " " || char === "/")) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Whether one radius value draws a corner past the sharp ceiling. */
export function isRound(rawValue) {
  const value = rawValue
    .replace(/!important/g, "")
    .replace(/["'`,}]/g, " ")
    .trim();
  if (!value || KEYWORD.test(value)) return false;
  return components(value).some((part) => {
    const px = evaluate(part);
    return px === null || px > SHARP_PX;
  });
}

/** Offsets of every round corner declared in `source` (comments blanked). */
export function roundCorners(source) {
  const hits = [];
  for (const match of source.matchAll(DECLARATION)) {
    if (isRound(match[1])) hits.push(match.index ?? 0);
  }
  return hits;
}

function readBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE, "utf8"));
    const plain =
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.getPrototypeOf(parsed) === Object.prototype;
    return plain ? parsed : {};
  } catch {
    return {};
  }
}

const baseline = readBaseline();

/**
 * Report the round corners in `source` beyond what `path` is recorded as
 * holding. A file with fewer than its record must lower the record.
 */
export function checkCorners(root, file, source, report, lineOf) {
  const path = relative(root, file).replaceAll("\\", "/");
  const hits = roundCorners(source);
  const recorded = Object.hasOwn(baseline, path) ? baseline[path] : 0;
  if (!Number.isInteger(recorded) || hits.length === recorded) return;
  if (hits.length < recorded) {
    report(
      file,
      1,
      "no-round-corners",
      `Round corners fell from ${recorded} to ${hits.length}. Lower ${path} in tools/quality/design-radius-baseline.json.`,
    );
    return;
  }
  for (const index of hits.slice(recorded)) {
    report(
      file,
      lineOf(source, index),
      "no-round-corners",
      "Corners are sharp: 0, or at most the 2px scale (`var(--radius)`). A pill, a circle, a percentage or a larger radius is a design violation. See DESIGN.md § Shapes.",
    );
  }
}
