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
 *   - `role="alert"`, `role='alert'` or `role={"alert"}` on anything a person
 *     can see (the tray announces; a `visually-hidden` live region is the one
 *     allowed spelling — the lint reads the whole opening tag the role sits in);
 *   - CSS that paints an error box: a rule for one of those classes, or any
 *     rule outside the allowlist that fills a block with the error wash.
 *
 * The `-error` rule is deliberately broad: it matches ANY string token that
 * ends in `-error` (`form-error`, `fetch-error`), because it cannot tell a
 * class from any other string. A token that is not a class — an event name, a
 * message key, a test id — must be renamed (`fetch-failure`), not exempted.
 *
 * The seam to use instead is `<FailureNotice>` / `useFailureNotice`
 * (`apps/pages/src/components/FailureNotice.tsx`) or `StatusNote`.
 */

const MESSAGE =
  "A failure is a StatusMark on the thing that failed, or a notice in the tray — never a red box or alert in the page. Mount <FailureNotice id title message /> (apps/pages/src/components/FailureNotice.tsx) or use StatusNote. See DESIGN.md § Status is a symbol and docs/design/controls.md.";

/**
 * Comments blanked in place — same length, same lines — so locations still
 * point. A small scanner, not a regex: a `//` inside `'…'`, `"…"` or `` `…` ``
 * (a protocol-relative URL) is text, and blanking the rest of its line would
 * hide a failing class written after it. Quotes close at a newline unless
 * they are template literals, so an apostrophe in JSX text cannot swallow the
 * file. A `//` right after `:` is the tail of an unquoted URL, not a comment.
 */
function blankComments(source) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  let out = "";
  let quote = null;
  let i = 0;
  while (i < source.length) {
    if (quote) {
      const taken = stringStep(source, i, quote);
      out += source.slice(i, taken.stop);
      quote = taken.quote;
      i = taken.stop;
      continue;
    }
    const stop = commentEnd(source, i);
    if (stop > i) {
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (`"'\``.includes(source[i])) quote = source[i];
    out += source[i];
    i += 1;
  }
  return out;
}

/** One step inside a string: past an escape pair, or past the closing quote. */
function stringStep(source, i, quote) {
  const c = source[i];
  if (c === "\\" && i + 1 < source.length) return { stop: i + 2, quote };
  const closes = c === quote || (c === "\n" && quote !== "`");
  return { stop: i + 1, quote: closes ? null : quote };
}

/** Where a comment starting at `i` ends, or `i` when none starts there. */
function commentEnd(source, i) {
  if (source[i] !== "/") return i;
  if (source[i + 1] === "*") {
    const end = source.indexOf("*/", i + 2);
    return end < 0 ? source.length : end + 2;
  }
  if (source[i + 1] === "/" && source[i - 1] !== ":") {
    const end = source.indexOf("\n", i);
    return end < 0 ? source.length : end;
  }
  return i;
}

/**
 * A class that names an error box. `chip--err` is a status chip, which
 * `status-is-symbol` owns, and `status-mark--err` is the glyph itself: neither
 * is matched here.
 */
const FAILURE_CLASS =
  /(?<![\w-])(?:note--\$\{|(?:note--err|broker__card--err|conn-flash|conn-error|[a-z][\w-]*__(?:error|err)|[a-z][\w-]*-error)(?![\w-]))/g;

/** Every spelling of `role="alert"`: a string, or a string in braces. */
const ALERT_ROLE =
  /\brole=(?:"alert"|'alert'|\{\s*"alert"\s*\}|\{\s*'alert'\s*\})/g;

/** Where the opening tag that holds `index` starts: the nearest `<` and a letter. */
function tagStart(code, index) {
  for (let at = index - 1; at >= 0; at -= 1) {
    if (code[at] === "<" && /[A-Za-z]/.test(code[at + 1] ?? "")) return at;
  }
  return index;
}

/** Where that tag ends: the first `>` outside braces and strings after `from`. */
function tagEnd(code, from) {
  let depth = 0;
  let quote = null;
  for (let at = from; at < code.length; at += 1) {
    const c = code[at];
    if (quote) {
      if (c === "\\") at += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === ">" && depth <= 0) return at + 1;
  }
  return code.length;
}

/** `role="alert"` on an element that is not a visually-hidden live region. */
function visibleAlerts(code) {
  const found = [];
  for (const match of code.matchAll(ALERT_ROLE)) {
    const start = tagStart(code, match.index ?? 0);
    const end = tagEnd(code, (match.index ?? 0) + match[0].length);
    if (/\bvisually-hidden\b/.test(code.slice(start, end))) continue;
    found.push(start);
  }
  return found;
}

export function checkInPageErrors(file, source, report, lineOf) {
  const code = blankComments(source);
  for (const match of code.matchAll(FAILURE_CLASS)) {
    report(file, lineOf(source, match.index ?? 0), "no-in-page-error", MESSAGE);
  }
  for (const start of visibleAlerts(code)) {
    report(file, lineOf(source, start), "no-in-page-error", MESSAGE);
  }
}

/**
 * Selectors that may carry the error colour: glyphs, the tray, an invalid
 * field. Never a control (`design-lint-ink.mjs`): there is no danger button.
 */
const ALLOWED_SELECTOR =
  /(chip--err|status-mark|notice-card|__danger|\[aria-invalid)/;

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
