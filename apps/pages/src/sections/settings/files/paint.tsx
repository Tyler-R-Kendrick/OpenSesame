/**
 * Colour for a settings file's text: keys, strings, numbers, booleans and
 * comments, in the classes `settings.css` colours (`set-raw__*`). The painted
 * copy sits under the textarea that owns the keys (`PaintedText`), so it must
 * keep every character of the text — a painter only wraps spans around it.
 */
import { valueClass } from "@opensesame/app-core/sections/settings/settings-raw-editor-model.js";
import type { FileLanguage } from "@opensesame/app-core/sections/settings/virtual-files.js";
import type { ReactNode } from "react";

/** The text, painted for its language; a language with no painter is plain. */
export function paintSource(
  language: FileLanguage,
  source: string,
): ReactNode[] {
  const paintLine =
    language === "yaml"
      ? paintYamlLine
      : language === "json"
        ? paintJsonLine
        : plainLine;
  return source.split("\n").map((line, index) => (
    // A line's position is its identity: the text under it is rewritten as
    // a person types, so a text-derived key would remount the whole line.
    // biome-ignore lint/suspicious/noArrayIndexKey: positional by design
    <span key={index}>
      {paintLine(line)}
      {"\n"}
    </span>
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
  if (item)
    return (
      <>
        {item[1]}
        {paintValue(item[2] ?? "")}
      </>
    );
  const at = line.indexOf(":");
  if (at < 0) return line;
  return (
    <>
      <span className="set-raw__key">{line.slice(0, at)}</span>:
      {paintValue(line.slice(at + 1))}
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

const JSON_TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

/** One line of JSON: keys, strings, numbers and the three literals. */
function paintJsonLine(line: string): ReactNode {
  const out: ReactNode[] = [];
  let from = 0;
  for (const match of line.matchAll(JSON_TOKEN)) {
    const at = match.index ?? 0;
    if (at > from) out.push(line.slice(from, at));
    const [whole, text, colon, number] = match;
    if (text !== undefined) {
      out.push(
        <span key={at} className={colon ? "set-raw__key" : "set-raw__str"}>
          {text}
        </span>,
      );
      if (colon) out.push(colon);
    } else {
      out.push(
        <span key={at} className={number ? "set-raw__num" : "set-raw__bool"}>
          {whole}
        </span>,
      );
    }
    from = at + whole.length;
  }
  if (from < line.length) out.push(line.slice(from));
  return out;
}
