/**
 * A settings file's text, painted beneath a textarea that owns the keys. The
 * one editing surface for every file Settings opens — a directory's
 * `config.yaml` and the files its providers keep — so a file reads the same
 * wherever it is opened: keys, strings, numbers and booleans in their colours.
 *
 * The painted copy and the textarea share one grid cell and one metrics
 * block, so the caret sits on the text drawn under it. A long line widens
 * both to the longest line (`--cols`, in `ch`) and the stage scrolls
 * sideways, which keeps the two aligned without syncing two scrollers.
 */
import type { FileLanguage } from "@opensesame/app-core/sections/settings/virtual-files.js";
import { type KeyboardEvent, type Ref, useLayoutEffect, useRef } from "react";
import { revealCaret } from "./caret-reveal.js";
import { longestLine } from "./lines.js";
import { paintSource } from "./paint.js";

export function PaintedText({
  language,
  path,
  source,
  readOnly = false,
  busy = false,
  invalid = false,
  inputRef,
  onChange,
  onKeyDown,
  onKeyUp,
  onFocus,
  painter = paintSource,
}: {
  language: FileLanguage;
  /** The file's path, which names the textarea. */
  path: string;
  source: string;
  readOnly?: boolean;
  /** The text is still arriving: shown as it is, not yet editable. */
  busy?: boolean;
  invalid?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  onChange?: (text: string, caret: number) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onKeyUp?: (caret: number) => void;
  onFocus?: () => void;
  /** Rendering port; the owner can size the editor independently of token painting. */
  painter?: typeof paintSource;
}) {
  const cols = longestLine(source);
  const stage = useRef<HTMLDivElement>(null);
  const paint = useRef<HTMLPreElement>(null);
  // A custom property is not a React style key; set it where it is read.
  useLayoutEffect(() => {
    stage.current?.style.setProperty("--cols", String(cols));
  }, [cols]);
  // The painted copy has just grown: the browser tried to show the caret
  // before it did, so show it now (only for someone typing, only if needed).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the text
  useLayoutEffect(() => {
    const field = stage.current?.querySelector("textarea");
    if (stage.current && paint.current && field)
      revealCaret(stage.current, paint.current, field);
  }, [source]);
  return (
    <div
      ref={stage}
      className={`set-raw__stage${readOnly ? " set-raw__stage--ro" : ""}`}
    >
      <pre ref={paint} className="set-raw__paint" aria-hidden="true">
        {painter(language, source)}
      </pre>
      <textarea
        ref={inputRef}
        className="set-raw__input"
        aria-label={path}
        aria-invalid={invalid ? true : undefined}
        aria-busy={busy ? true : undefined}
        spellCheck={false}
        autoComplete="off"
        wrap="off"
        readOnly={readOnly || busy}
        value={source}
        onFocus={onFocus}
        onChange={(event) =>
          onChange?.(event.target.value, event.target.selectionStart)
        }
        onKeyUp={(event) => onKeyUp?.(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
