const SOURCES_LINE = /^sources?\s*:/iu;
const NONE_SOURCES = new Set(["", "none", "n/a", "-", "—"]);

export type SupportSourcesExtraction = {
  /** The answer with its `sources:` line removed. */
  readonly answer: string;
  /** `null` when the answer carried no `sources:` line at all. */
  readonly cited: readonly string[] | null;
};

/**
 * Splits the trailing `sources:` line off an answer. Only the last non-blank
 * line counts: a model that mentions "sources" mid-answer has said a word, not
 * made a citation. Identifiers are taken as written, minus the quoting a
 * model tends to add, and are matched against the context by the caller — the
 * text here is still model output and proves nothing by itself.
 */
export function extractSupportSources(
  answer: string,
): SupportSourcesExtraction {
  const lines = answer.split(/\r?\n/);
  let last = lines.length - 1;
  while (last >= 0 && (lines[last] ?? "").trim().length === 0) last -= 1;
  if (last < 0) return { answer: answer.trim(), cited: null };
  const sourceLine = (lines[last] ?? "").trimStart();
  const match = SOURCES_LINE.exec(sourceLine);
  if (match === null) return { answer: answer.trim(), cited: null };
  const sourceText = sourceLine.slice(match[0].length).trimStart();
  if (/[\r\u2028\u2029]/u.test(sourceText))
    return { answer: answer.trim(), cited: null };
  const cited = sourceText
    .split(/[,;\s]+/u)
    .map((token) =>
      stripCitationSuffix(token).replace(/^[`'"\[\]()<>*]+/gu, ""),
    )
    .map((token) => token.trim().toLowerCase())
    .filter((token) => !NONE_SOURCES.has(token));
  return {
    answer: lines.slice(0, last).join("\n").trim(),
    cited,
  };
}

function stripCitationSuffix(token: string): string {
  let end = token.length;
  while (end > 0 && "`'\"[]()<>*.".includes(token[end - 1] ?? "")) end -= 1;
  return token.slice(0, end);
}
