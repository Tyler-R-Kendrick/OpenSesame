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
import { paintSource } from "./paint.js";

export function PaintedText({
  language,
  path,
  source,
  readOnly = false,
  invalid = false,
  inputRef,
  onChange,
  onKeyDown,
  onKeyUp,
  onFocus,
}: {
  language: FileLanguage;
  /** The file's path, which names the textarea. */
  path: string;
  source: string;
  readOnly?: boolean;
  invalid?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  onChange?: (text: string, caret: number) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onKeyUp?: (caret: number) => void;
  onFocus?: () => void;
}) {
  const cols = Math.max(0, ...source.split("\n").map((line) => line.length));
  const stage = useRef<HTMLDivElement>(null);
  // A custom property is not a React style key; set it where it is read.
  useLayoutEffect(() => {
    stage.current?.style.setProperty("--cols", String(cols));
  }, [cols]);
  return (
    <div
      ref={stage}
      className={`set-raw__stage${readOnly ? " set-raw__stage--ro" : ""}`}
    >
      <pre className="set-raw__paint" aria-hidden="true">
        {paintSource(language, source)}
      </pre>
      <textarea
        ref={inputRef}
        className="set-raw__input"
        aria-label={path}
        aria-invalid={invalid ? true : undefined}
        spellCheck={false}
        autoComplete="off"
        wrap="off"
        readOnly={readOnly}
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
