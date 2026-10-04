import { useId } from "react";
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
 * page: it goes to the notifications tray (the bell), where it can be read,
 * retried and dismissed, and where it survives leaving this screen.
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
  useFailureNotice(
    id,
    title ?? (failed?.tone === "warn" ? DEFAULT_TITLE.warn : DEFAULT_TITLE.err),
    failed?.text,
    failed?.tone === "warn" ? "warn" : "err",
  );

  if (!message || message.tone !== "ok") return null;
  return (
    <output className="note note--ok">
      <span>{message.text}</span>
    </output>
  );
}
