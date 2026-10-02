/**
 * Prose the design contract reads in every string literal and
 * every status chip: a status states the fact and stops — it
 * never consoles, walks the browser's own settings, or
 * apologises for what it cannot turn on, and it wears a
 * StatusMark glyph, never a painted word. The helpers the
 * checks report through (`report`, `lineOf`) are passed in by
 * the caller, so this module owns no paths and no file system.
 */

/** A quote character and the string mode it opens. */
const QUOTES = { "'": "sq", '"': "dq", "`": "tick" };
/** The character that closes each string mode. */
const CLOSING = { dq: '"', sq: "'", tick: "`" };

/**
 * The text of every string literal, with comments skipped: a `//`
 * inside a URL string is not a comment, and a quote inside a
 * comment is not UI copy. One walk, tracking string and comment
 * state, so a browser-settings address inside a status is read as
 * the copy it is.
 */
function stringLiterals(source) {
  const out = [];
  let mode = "code"; // code | line | block | dq | sq | tick
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (mode === "code") {
      if (c === "/") {
        if (next === "/") {
          mode = "line";
          i++;
        } else if (next === "*") {
          mode = "block";
          i++;
        }
      } else if (QUOTES[c]) {
        mode = QUOTES[c];
        start = i + 1;
      }
    } else if (mode === "line") {
      if (c === "\n") mode = "code";
    } else if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code";
        i++;
      }
    } else if (c === "\\") {
      i++;
    } else if (CLOSING[mode] === c) {
      out.push(source.slice(start, i));
      mode = "code";
    }
  }
  return out;
}

/**
 * Explainer copy a status must not carry: a consolation tail, a
 * walk through the browser's own settings, or a capability the app
 * disclaims. A status states the fact and stops — it never consoles,
 * instructs the browser, or apologises for what it cannot turn on.
 */
const STATUS_EXPLAINER =
  /still works|chrome:\/\/flags|relaunch|reload this page|cannot enable/i;

function checkProse(file, source, report) {
  for (const literal of stringLiterals(source)) {
    if (!STATUS_EXPLAINER.test(literal)) continue;
    report(
      file,
      1,
      "no-status-explainer",
      "A status states the fact. It does not console ('still works'), walk the browser's own settings (chrome://flags, relaunch, reload), or disclaim what the app cannot enable.",
    );
    return;
  }
}

function checkStatusPills(file, source, report, lineOf) {
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

export { checkProse, checkStatusPills };
