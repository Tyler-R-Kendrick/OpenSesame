import { useId, useRef } from "react";
import { useFailureNotice } from "./use-failure-notice.js";

export type StatusTone = "ok" | "err" | "warn";

export interface StatusMessage {
  tone: StatusTone;
  text: string;
}

const DEFAULT_TITLE = {
  err: "Something went wrong",
  warn: "Heads up",
} as const;

/**
 * Outcome of the nearest action.
 *
 * Success stays quiet, inline. A failure or warning is never drawn in the
 * page: it goes to the notifications tray (the bell), where it can be read and
 * dismissed. An inline outcome belongs to this component, so the notice is
 * cleared when it unmounts.
 */
export function StatusNote({
  message,
  title,
}: {
  message: StatusMessage | null;
  title?: string;
}) {
  const id = `status-note:${useId()}`;
  const failed = message && message.tone !== "ok" ? message : null;
  // Callers may build the message inline on every render, so its identity says
  // nothing about whether the failure is new. A failure is new when there was
  // none a moment ago, or when its tone or sentence changed; a dismissed notice
  // must not come back because an unrelated render rebuilt the same object.
  const seen = useRef({ key: "", count: 0 });
  const key = failed ? `${failed.tone}\u0000${failed.text}` : "";
  if (seen.current.key !== key)
    seen.current = { key, count: seen.current.count + 1 };
  useFailureNotice(
    id,
    title ?? (failed?.tone === "warn" ? DEFAULT_TITLE.warn : DEFAULT_TITLE.err),
    failed?.text,
    failed?.tone === "warn" ? "warn" : "err",
    // The notice goes with the component, which callers mount only while a
    // message exists.
    { occurrence: seen.current.count, clearOnUnmount: true },
  );

  if (!message || message.tone !== "ok") return null;
  return (
    <output className="note note--ok">
      <span>{message.text}</span>
    </output>
  );
}
