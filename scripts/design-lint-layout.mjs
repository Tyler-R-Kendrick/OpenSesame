/**
 * Design lint — where a key lives and how wide a field grows
 * (DESIGN.md § Keys have a home, § Fields have a measure).
 *
 * Split from `design-lint.mjs`, which runs these, so each file stays one
 * idea. Both checks are about layout that no screenshot of a short fixture
 * shows: a commit key that sits on a row of its own under the form it
 * saves, and a field rule that lets an input grow as wide as its panel.
 */

/**
 * The wrappers a commit key may end: the row of the field it commits, a
 * field shell's tail, or an inline one-field form. Anywhere else a bare
 * icon-key submit is a glyph on a line of its own, and a form with several
 * fields commits with `FormCommit` (the `.go` square and its verb).
 */
const KEY_HOMES =
  /\b(keyed-row|field-inline|identifier__row|set__inline)\b|<FieldShell\b|\btail=\{/;

/** The open tag of the element starting at `from`, braces balanced. */
function openTag(source, from) {
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return source.slice(from, index + 1);
  }
  return source.slice(from);
}

/**
 * The elements enclosing a line, nearest first, read from indentation: the
 * formatter indents every child deeper than its parent, so the first shallower
 * line that opens a tag or a prop is the parent.
 */
function enclosing(lines, lineIndex, limit = 3) {
  const found = [];
  let depth = lines[lineIndex].length - lines[lineIndex].trimStart().length;
  for (
    let index = lineIndex - 1;
    index >= 0 && found.length < limit;
    index -= 1
  ) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent >= depth) continue;
    const text = line.trim();
    if (!text.startsWith("<") && !/^\w+=\{/.test(text)) continue;
    found.push(text);
    depth = indent;
  }
  return found;
}

export function checkCommitKeys(file, source, report, lineOf) {
  const lines = source.split("\n");
  for (const match of source.matchAll(/<button\b/g)) {
    const tag = openTag(source, match.index ?? 0);
    if (!/type="submit"/.test(tag) || !/\bicon-btn\b/.test(tag)) continue;
    const line = lineOf(source, match.index ?? 0);
    const parents = enclosing(lines, line - 1).join("\n");
    if (KEY_HOMES.test(parents)) continue;
    report(
      file,
      line,
      "commit-key-has-a-home",
      "A form's commit key ends the row of the field it commits (`field-inline`, `keyed-row`, a FieldShell `tail`). A form of several fields commits with `FormCommit` — the `.go` square and its verb — never a bare glyph on a row of its own.",
    );
  }
}

/** Selectors naming a text field: not a checkbox, a radio, a range or a file. */
const FIELD =
  /(^|[\s,>+~(])(input|select|textarea)\b(?![-\w])(?!\[type="(checkbox|radio|range|file|hidden|color)"\])|__(input|select)\b/;

/**
 * A field rule that stretches a field to its container without a measure.
 * The base rule in the control home sets `--field-max`; a rule elsewhere that
 * restates `width: 100%` must restate a `max-width` too — the token, the
 * wider `--text-max` for an editor, or `none` for an overlay that has to span
 * exactly what it covers.
 */
export function checkFieldWidths(file, css, report, lineOf) {
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1].trim();
    if (!FIELD.test(selector)) continue;
    const body = block[2];
    if (!/(?:^|;)\s*width\s*:\s*100%/.test(body)) continue;
    if (/max-width\s*:/.test(body)) continue;
    report(
      file,
      lineOf(css, block.index ?? 0),
      "field-has-a-measure",
      "A field stretched to its panel reads as a rule, not a control. Give the rule a `max-width` — `var(--field-max)`, `var(--text-max)` for an editor, or `none` for an overlay.",
    );
  }
}
