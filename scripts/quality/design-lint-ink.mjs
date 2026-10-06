/**
 * Design lint — a control never wears the error ink.
 *
 * `DESIGN.md` § Actions and `docs/design/controls.md` § 0: red is a status, and
 * a status is a `StatusMark` glyph, the tray's card, or an `aria-invalid`
 * border. A control — a `button`, `.btn`, `.go`, `.icon-btn` or any key — is
 * ink on paper, hairline on surface, ghost. The one irreversible act is the
 * ordinary `.go` square with the trash glyph, a facts card that says what goes,
 * and a safe key where the keyboard lands; its weight is never paint.
 *
 * What the rule refuses, because each has been how a red key got in:
 *
 *   - a `*--danger` modifier on a control, in a class string (`btn--danger`,
 *     `go--danger`, `icon-btn--danger`, `set__nav-link--danger`);
 *   - a CSS rule for a control, a `--danger` modifier or an armed key that
 *     reads an error token (`--err`, `--err-wash`, `--err-ink`, `--danger`) for
 *     any colour, fill, stroke, border or shadow.
 *
 * No ledger: the count is zero everywhere, and a new file meets it outright.
 */

const MESSAGE =
  "A control never wears the error ink: a destructive act is the ordinary `.go` square or icon key (ink on paper), and its weight is the trash glyph, the card's facts and the safe key. Red belongs to a status — `StatusMark`, the tray card, an `aria-invalid` border. See DESIGN.md § Actions and docs/design/controls.md.";

/** A class modifier that paints a control red. */
const DANGER_CLASS =
  /(?<![\w-])(?:btn|go|icon-btn|icon-key|set__nav-link)--danger(?![\w-])/g;

/** A selector that names a control, or a danger or armed state of one. */
const CONTROL =
  /(?:^|[\s>+~(,])(?:button|\.(?:btn|go|icon-btn|icon-key|choice|road|scrim|fab)(?![\w-]))|--danger|\.is-armed(?![\w-])|__nav-link(?![\w-])|__(?:go|mic|key|keys|btn|button|switch|toggle|close)(?![\w-])/;

/** An error token read by a declaration. */
const ERROR_INK = /var\(\s*--(?:err|err-wash|err-ink|danger)\b/;

/** Keep line structure while removing comments, so locations still point. */
function blankComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (text) =>
    text.replace(/[^\n]/g, " "),
  );
}

/** A class string in a .tsx/.ts file that names a danger modifier. */
export function checkDangerClasses(file, source, report, lineOf) {
  for (const match of source.matchAll(DANGER_CLASS)) {
    report(file, lineOf(source, match.index ?? 0), "no-danger-control", MESSAGE);
  }
}

/** A CSS rule for a control that reads an error token. */
export function checkControlInk(file, source, report, lineOf) {
  const css = blankComments(source);
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim();
    if (selector.startsWith("@") || selector === "") continue;
    if (!CONTROL.test(selector)) continue;
    if (!ERROR_INK.test(rule[2])) continue;
    report(
      file,
      lineOf(source, (rule.index ?? 0) + rule[0].indexOf(selector)),
      "no-control-error-ink",
      MESSAGE,
    );
  }
  for (const match of css.matchAll(DANGER_CLASS)) {
    report(
      file,
      lineOf(source, match.index ?? 0),
      "no-danger-control",
      MESSAGE,
    );
  }
}
