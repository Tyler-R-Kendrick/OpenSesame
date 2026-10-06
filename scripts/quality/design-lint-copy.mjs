/**
 * Design lint — copy that narrates instead of showing (DESIGN.md, `controls.md` § 0).
 *
 * Split from `design-lint.mjs`, which owns the sweep and the ledgers. Two
 * checks live here because they are one idea: a screen may not describe itself.
 *
 *   - `no-explainer` — a caption that narrates a panel instead of showing the
 *     row, field or receipt it stands for.
 *   - `status-is-symbol` — status painted as a word on a chip.
 *
 * `root`, `report` and `lineOf` are passed in rather than reached for, so this
 * module owns one idea and no sweep state of its own.
 */

import { relative } from "node:path";

/** Captions that narrate a connector panel instead of showing the row. */
const EXPLAINER =
  /this app is installed|permissions it was granted|repositories it can reach|saved in this app|already saved in this app|no permissions recorded|no repositories returned|no github user or organization|loading github app access|mirrored as a revocable/i;

function checkExplainers(root, file, source, report, lineOf) {
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

/** Both, in the order a reader meets them. */
export function checkCopy(root, file, source, report, lineOf) {
  checkExplainers(root, file, source, report, lineOf);
  checkStatusPills(file, source, report, lineOf);
}
