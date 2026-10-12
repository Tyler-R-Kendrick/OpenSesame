/**
 * Design lint — a `hint` is a fact, never a caption (DESIGN.md, `controls.md` § 0).
 *
 * `no-explainer` reads one panel family by phrase; this reads every screen by
 * shape. A `.hint` element (or a `FieldShell` `hint` prop) that carries a
 * sentence of static prose — what the control does, why it is there, what it
 * will not do — is a caption on a picture the person is already looking at,
 * and it costs a row of the form. The control's `aria-label` and `title` carry
 * that sentence. A fact stays: `Enrolled {date}`, `Expires {time}`, `Callback:
 * {url}`, `No receipts yet.`
 *
 *   - `no-hint-caption` — a `hint` element whose static copy runs five words
 *     or more, whose copy comes from a help/guidance/note property, or a
 *     `FieldShell` given a `hint` at all.
 *
 * Written as shape rather than phrase so a new caption fails on arrival
 * instead of waiting for someone to add its words to a list. There is no
 * ledger: the count is zero everywhere.
 *
 * `report` and `lineOf` are passed in, so this module owns no sweep state.
 */

/** Static prose at or past this many words is a sentence, not a fact. */
const SENTENCE_WORDS = 5;

/** A property that holds explanatory copy, not data. */
const PROSE_SOURCE =
  /\b(?:help|configureHint|guidance|reason|note)\b|\bfield\.hint\b/;

const MESSAGE =
  "A hint is a fact, not a caption. Do not add a line that says what a control does, why it is there, or what it will not do; put that sentence on the control's `aria-label`/`title`, or say nothing. See docs/design/controls.md § 0.";

/** Index just past the `>` that ends the tag opened at `from`. */
function tagEnd(source, from) {
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0 && source[index - 1] !== "=") {
      return index + 1;
    }
  }
  return source.length;
}

/**
 * The words a hint's body states: JSX text outside braces plus every string
 * literal inside them, and whether any brace expression reads from a property
 * that holds explanatory copy.
 */
function copyOf(body) {
  let text = "";
  let words = 0;
  let proseSource = false;
  let depth = 0;
  let expression = "";
  for (const char of body) {
    if (char === "{") {
      depth += 1;
      if (depth === 1) continue;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        if (PROSE_SOURCE.test(expression)) proseSource = true;
        for (const literal of expression.matchAll(
          /"([^"\n]*)"|'([^'\n]*)'|`([^`$]*)`/g,
        )) {
          text += ` ${literal[1] ?? literal[2] ?? literal[3]}`;
        }
        expression = "";
        continue;
      }
    }
    if (depth > 0) expression += char;
    else text += char;
  }
  const prose = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&\w+;/g, " ")
    .match(/[A-Za-z][A-Za-z'’-]*/g);
  words = prose ? prose.length : 0;
  return { words, proseSource };
}

/** `className="hint"`, `className="hint x"`, `className="x__hint"`. */
const HINT_ELEMENT =
  /<(p|span|div)\b(?=[^>]*\bclassName="(?:[^"]*\s)?(?:[\w-]+__)?hint(?:\s[^"]*)?")/g;

function checkHintElements(file, source, report, lineOf) {
  for (const match of source.matchAll(HINT_ELEMENT)) {
    const start = match.index ?? 0;
    const open = tagEnd(source, start);
    const close = source.indexOf(`</${match[1]}>`, open);
    if (close === -1) continue;
    const { words, proseSource } = copyOf(source.slice(open, close));
    if (words < SENTENCE_WORDS && !proseSource) continue;
    report(file, lineOf(source, start), "no-hint-caption", MESSAGE);
  }
}

function checkFieldShellHints(file, source, report, lineOf) {
  for (const match of source.matchAll(/<FieldShell\b/g)) {
    const start = match.index ?? 0;
    const tag = source.slice(start, tagEnd(source, start));
    const attribute = /\shint=/.exec(tag);
    if (!attribute) continue;
    report(
      file,
      lineOf(source, start + attribute.index),
      "no-hint-caption",
      MESSAGE,
    );
  }
}

export function checkHintCaptions(file, source, report, lineOf) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  checkHintElements(file, code, report, lineOf);
  checkFieldShellHints(file, code, report, lineOf);
}
