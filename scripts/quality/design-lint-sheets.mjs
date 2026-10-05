/**
 * Design lint — the shapes a confirmation sheet hid behind
 * (DESIGN.md § Actions are symbols, `controls.md` § 0).
 *
 * "Reset this browser?" passed every check and was still the thing the
 * contract forbids: a warning-washed card under a title it repeated, a
 * kicker phrased as a question, the verb painted across a red slab, and a
 * sentence in the foot explaining what the sheet would not touch. None of
 * it was visible to the lint, because none of it was written where the lint
 * read:
 *
 *   - `word-slot` — the verbs reached the button through a prop
 *     (`primary={{ label: "Erase everything…" }}`), and the component that
 *     painted them read `{primary.label}`, which no literal check can see. A
 *     button whose face is a prop is a word slot; the slot is the failure,
 *     wherever the words come from.
 *   - `sheet-caption` — a sheet's head is its mark, its name and its close
 *     key; its foot is not a caption line. A `subtitle` or `foot` prop, a
 *     `<p>` in a `sheet__head`, or a `hint` in a `sheet__foot` is prose about
 *     the sheet rather than the sheet.
 *   - `ask-is-not-alarm` — a ceremony that asks before an irreversible act
 *     (`tone: "danger"`) has not failed, so it wears neither the warning wash
 *     (`ok={false}`) nor a kicker (`top=`): the danger key carries it.
 *   - `top-is-a-fact` — `CeremonyShell`'s top line is a fact ("Enrolled 28
 *     Aug", "7 of 10 left"), never a question.
 *   - `title-said-once` — a ceremony's `name` or `top` that repeats the
 *     sheet's own title says the title twice.
 *
 * `report` and `lineOf` are passed in, so this module owns no sweep state.
 */

import { wordsAreChoice } from "./design-lint-verbs.mjs";

/** Index just past the `>` that ends the tag opened at `from`. */
function tagEnd(source, from) {
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return index + 1;
  }
  return source.length;
}

/** The value of one attribute in an open tag, braces balanced. */
function attribute(tag, name) {
  const match = new RegExp(`\\s${name}=`).exec(tag);
  if (!match) return null;
  const start = match.index + match[0].length;
  if (tag[start] === '"')
    return tag.slice(start, tag.indexOf('"', start + 1) + 1);
  if (tag[start] !== "{") return null;
  let depth = 0;
  for (let index = start; index < tag.length; index += 1) {
    if (tag[index] === "{") depth += 1;
    else if (tag[index] === "}") {
      depth -= 1;
      if (depth === 0) return tag.slice(start, index + 1);
    }
  }
  return tag.slice(start);
}

/**
 * The text-button family (`btn`, `btn--primary`, `btn--danger`…): the slab a
 * verb gets painted on. Any prop or variable it renders is a slot, unless the
 * button says its words are the thing chosen (the classes and roles
 * `design-lint-verbs.mjs` already accepts).
 */
const TEXT_BUTTON = /(^|[\s"'`{])btn(?![\w-]*__)\b/;

function slotBranches(expression) {
  return expression
    .split(/\?\?|\|\||&&|\?|:/)
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z_$][\w$]*(\??\.[\w$]+)*$/.test(part));
}

function checkWordSlots(file, source, report, lineOf) {
  for (const match of source.matchAll(/<button\b/g)) {
    const start = match.index ?? 0;
    const end = tagEnd(source, start);
    const tag = source.slice(start, end);
    if (tag.endsWith("/>")) continue;
    if (!TEXT_BUTTON.test(attribute(tag, "className") ?? "")) continue;
    if (wordsAreChoice(tag)) continue;
    const close = source.indexOf("</button>", end);
    if (close === -1) continue;
    // The face, without the tags nested in it: an icon's props are not words.
    const face = source.slice(end, close).replace(/<[^>]*>/g, " ");
    const slot = [...face.matchAll(/\{([^{}]*)\}/g)]
      .flatMap((expression) => slotBranches(expression[1]))
      .find((name) => !/^(null|undefined|true|false)$/.test(name));
    if (!slot) continue;
    report(
      file,
      lineOf(source, start),
      "word-slot",
      `This button paints \`${slot}\` on its face: a verb passed in a prop is still a verb on a button, and no check can read it there. Draw the action as \`.go\` with its verb beside it, or an icon key whose \`aria-label\` and \`title\` carry the words. See DESIGN.md § Actions are symbols.`,
    );
  }
}

/** The JSX block a `className` opens, to its closing tag at the same depth. */
function elementAt(source, from) {
  const open = source.lastIndexOf("<", from);
  const name = /^<([\w.]+)/.exec(source.slice(open))?.[1];
  if (!name) return "";
  let depth = 0;
  const pattern = new RegExp(`<${name}\\b|</${name}>`, "g");
  for (const step of source.slice(open).matchAll(pattern)) {
    if (step[0].startsWith("</")) depth -= 1;
    else depth += 1;
    if (depth === 0)
      return source.slice(open, open + step.index + step[0].length);
  }
  return source.slice(open);
}

const CAPTION =
  "A sheet is its mark, its name and its keys. A line under the title or in the foot that tells the person what the sheet will or will not do is explainer prose; the facts and the keys already say it. See docs/design/controls.md § 0.";

function checkSheetCaptions(file, source, report, lineOf) {
  for (const match of source.matchAll(/\s(subtitle|foot)=[{"]/g)) {
    report(file, lineOf(source, match.index ?? 0), "sheet-caption", CAPTION);
  }
  for (const match of source.matchAll(/\bsetFoot\(/g)) {
    report(file, lineOf(source, match.index ?? 0), "sheet-caption", CAPTION);
  }
  for (const match of source.matchAll(/className="sheet__(head|foot)"/g)) {
    const block = elementAt(source, match.index ?? 0);
    const prose =
      match[1] === "head" ? /<p\b/.test(block) : /\bhint\b/.test(block);
    if (prose) {
      report(file, lineOf(source, match.index ?? 0), "sheet-caption", CAPTION);
    }
  }
}

/** Lowercase letters only, so "Reset this browser?" equals "Reset this browser". */
function words(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A string literal a prop holds: `"…"`, `{"…"}` or a template without holes. */
function literal(value) {
  if (!value) return null;
  const match = /^\{?\s*(?:"([^"]*)"|`([^`$]*)`)\s*\}?$/.exec(value);
  return match ? (match[1] ?? match[2]) : null;
}

/** Every title a sheet in this file announces. */
function sheetTitles(source) {
  const titles = new Set();
  for (const match of source.matchAll(/<h2>([^<{]+)<\/h2>/g)) {
    titles.add(words(match[1]));
  }
  for (const match of source.matchAll(/<(\w+Sheet|SheetFrame)\b/g)) {
    const tag = source.slice(match.index, tagEnd(source, match.index ?? 0));
    const title = literal(attribute(tag, "title"));
    if (title) titles.add(words(title));
  }
  for (const match of source.matchAll(/role="dialog"/g)) {
    const open = source.lastIndexOf("<", match.index);
    const tag = source.slice(open, tagEnd(source, open));
    const title = literal(attribute(tag, "aria-label"));
    if (title) titles.add(words(title));
  }
  titles.delete("");
  return titles;
}

function checkCeremonies(file, source, report, lineOf) {
  const titles = sheetTitles(source);
  for (const match of source.matchAll(/<CeremonyShell\b/g)) {
    const start = match.index ?? 0;
    const tag = source.slice(start, tagEnd(source, start));
    const line = lineOf(source, start);
    const top = attribute(tag, "top");
    const asks = /tone:\s*"danger"/.test(attribute(tag, "primary") ?? "");
    if (asks && (top || /\sok=\{false\}/.test(tag))) {
      report(
        file,
        line,
        "ask-is-not-alarm",
        "A ceremony that asks before an irreversible act has not failed: no warning wash (`ok={false}`) and no kicker (`top`). The danger key carries the weight.",
      );
    }
    if (top && /\?\s*["'`]?\s*\}?$/.test(top)) {
      report(
        file,
        line,
        "top-is-a-fact",
        'A ceremony\'s top line is a fact ("Enrolled 28 Aug", "7 of 10 left"), never a question. Leave it out of a card for something that has not happened yet.',
      );
    }
    for (const prop of ["name", "top"]) {
      const text = literal(attribute(tag, prop));
      if (text && titles.has(words(text))) {
        report(
          file,
          line,
          "title-said-once",
          `The ceremony's \`${prop}\` repeats the sheet's title. Name the object the ceremony acts on — the vault, the key, the origin — not the question again.`,
        );
      }
    }
  }
}

/** Every check, for one `.tsx` file. */
export function checkSheets(file, source, report, lineOf) {
  checkWordSlots(file, source, report, lineOf);
  checkSheetCaptions(file, source, report, lineOf);
  checkCeremonies(file, source, report, lineOf);
}
