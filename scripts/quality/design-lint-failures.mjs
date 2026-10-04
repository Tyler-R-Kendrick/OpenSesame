/**
 * Design lint — a failure is never drawn in the page.
 *
 * `DESIGN.md` § Status is a symbol, `docs/design/controls.md` § 0 and AGENTS.md
 * §5 say the same thing: a failure is a `StatusMark` on the row, field or
 * receipt that failed, and a sentence about it is a notice in the tray (the
 * bell). Never a red box inside the screen. This is the rule that ratcheted
 * per file until it reached zero; it is now a plain failure, with no ledger.
 *
 * What the rule refuses, because each of these has been how a red box got in:
 *
 *   - an error-box class: `note--err`, a dynamic `note--${tone}`, `conn-error`,
 *     `conn-flash`, `broker__card--err`, any `*__error` / `*__err` / `*-error`;
 *   - `role="alert"` on anything a person can see (the tray announces; a
 *     `visually-hidden` live region is the one allowed spelling);
 *   - CSS that paints an error box: a rule for one of those classes, or any
 *     rule outside the allowlist that fills a block with the error wash.
 *
 * The seam to use instead is `<FailureNotice>` / `useFailureNotice`
 * (`apps/pages/src/components/FailureNotice.tsx`) or `StatusNote`.
 */

const MESSAGE =
  "A failure is a StatusMark on the thing that failed, or a notice in the tray — never a red box or alert in the page. Mount <FailureNotice id title message /> (apps/pages/src/components/FailureNotice.tsx) or use StatusNote. See DESIGN.md § Status is a symbol and docs/design/controls.md.";

/** Comments blanked in place — same length, same lines — so locations still point. */
function blankComments(source) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(
      /(^|[^:])(\/\/[^\n]*)/g,
      (_, lead, comment) => lead + blank(comment),
    );
}

/**
 * A class that names an error box. `chip--err` is a status chip, which
 * `status-is-symbol` owns, and `status-mark--err` is the glyph itself: neither
 * is matched here.
 */
const FAILURE_CLASS =
  /(?<![\w-])(?:note--\$\{|(?:note--err|broker__card--err|conn-flash|conn-error|[a-z][\w-]*__(?:error|err)|[a-z][\w-]*-error)(?![\w-]))/g;

/** `role="alert"` on an element that is not a visually-hidden live region. */
const VISIBLE_ALERT = /<[A-Za-z][\w.]*\b[^>]*?\brole=["']alert["'][^>]*>/g;

export function checkInPageErrors(file, source, report, lineOf) {
  const code = blankComments(source);
  for (const match of code.matchAll(FAILURE_CLASS)) {
    report(file, lineOf(source, match.index ?? 0), "no-in-page-error", MESSAGE);
  }
  for (const match of code.matchAll(VISIBLE_ALERT)) {
    if (/\bvisually-hidden\b/.test(match[0])) continue;
    report(file, lineOf(source, match.index ?? 0), "no-in-page-error", MESSAGE);
  }
}

/** Selectors that may carry the error colour: controls, glyphs, the tray. */
const ALLOWED_SELECTOR =
  /(btn--danger|icon-btn--danger|chip--err|status-mark|notice-card|--danger|__danger|\.is-hot|\.is-danger|\.is-armed|\[aria-invalid)/;

const FAILURE_SELECTOR =
  /(\.note--err|\.broker__card--err|\.conn-flash|\.conn-error|__error\b|__err\b|-error\b)/;

const FILLS_ERROR =
  /(?:^|;)\s*background(?:-color)?\s*:[^;]*var\(--err(?:-wash)?\)/;

export function checkFailureCss(file, source, report, lineOf) {
  const css = blankComments(source);
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1].trim();
    if (selector.startsWith("@")) continue;
    if (ALLOWED_SELECTOR.test(selector)) continue;
    if (FAILURE_SELECTOR.test(selector) || FILLS_ERROR.test(block[2])) {
      report(
        file,
        lineOf(
          source,
          (block.index ?? 0) + block[1].length - block[1].trimStart().length,
        ),
        "no-error-box-css",
        `\`${selector.replace(/\s+/g, " ")}\` paints a failure into the page. ${MESSAGE}`,
      );
    }
  }
}
