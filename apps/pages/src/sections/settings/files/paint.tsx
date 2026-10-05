/**
 * Colour for a settings file's text: keys, strings, numbers, booleans and
 * comments, in the classes `settings.css` colours (`set-raw__*`). The painted
 * copy sits under the textarea that owns the keys (`PaintedText`), so it must
 * keep every character of the text — a painter only wraps spans around it.
 */
import { valueClass } from "@opensesame/app-core/sections/settings/settings-raw-editor-model.js";
import type { FileLanguage } from "@opensesame/app-core/sections/settings/virtual-files.js";
import { type ReactNode, memo } from "react";
import { paintJsonLine } from "./paint-json.js";

/** Who painted a line; a test seam, unset in the app. */
let onLinePainted: ((language: FileLanguage, line: string) => void) | undefined;

/** Hear every line that is actually painted (not skipped as unchanged). */
export function traceLinePaints(
  listener: ((language: FileLanguage, line: string) => void) | undefined,
): void {
  onLinePainted = listener;
}

function painterFor(language: FileLanguage): (line: string) => ReactNode {
  if (language === "yaml") return paintYamlLine;
  if (language === "json") return paintJsonLine;
  return plainLine;
}

/** One painted line. Memoised on its language and text, so a keystroke
 * repaints the line it changed and React skips the other thousand. */
const PaintedLine = memo(function PaintedLine({
  language,
  line,
}: {
  language: FileLanguage;
  line: string;
}) {
  onLinePainted?.(language, line);
  return (
    <span>
      {painterFor(language)(line)}
      {"\n"}
    </span>
  );
});

/** The text, painted for its language; a language with no painter is plain. */
export function paintSource(
  language: FileLanguage,
  source: string,
): ReactNode[] {
  // A line's position is its identity: the text under it is rewritten as a
  // person types, so a text-derived key would remount the whole line.
  return source.split("\n").map((line, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: positional by design
    <PaintedLine key={index} language={language} line={line} />
  ));
}

function plainLine(line: string): ReactNode {
  return line;
}

/** `key: value # comment`, `- value`, and `# comment`. */
function paintYamlLine(line: string): ReactNode {
  if (line.trimStart().startsWith("#"))
    return <span className="set-raw__comment">{line}</span>;
  const item = /^(\s*-\s+)(.*)$/.exec(line);
  if (item) return paintItem(item[1] ?? "", item[2] ?? "");
  const at = line.indexOf(":");
  if (at < 0) return line;
  return (
    <>
      <span className="set-raw__key">{line.slice(0, at)}</span>:
      {paintValue(line.slice(at + 1))}
    </>
  );
}

/** A list item: a scalar is a value; `key: value` is a map's first pair. */
function paintItem(lead: string, body: string): ReactNode {
  const pair = /^([\w.-]+):(\s.*|)$/.exec(body);
  if (!pair) {
    return (
      <>
        {lead}
        {paintValue(body)}
      </>
    );
  }
  return (
    <>
      {lead}
      <span className="set-raw__key">{pair[1]}</span>:
      {paintValue(pair[2] ?? "")}
    </>
  );
}

/** A value and the comment that may follow it on the same line. */
function paintValue(rest: string): ReactNode {
  const hash = rest.search(/\s#/);
  const value = hash < 0 ? rest : rest.slice(0, hash);
  const comment = hash < 0 ? "" : rest.slice(hash);
  return (
    <>
      <span className={valueClass(value)}>{value}</span>
      {comment ? <span className="set-raw__comment">{comment}</span> : null}
    </>
  );
}
