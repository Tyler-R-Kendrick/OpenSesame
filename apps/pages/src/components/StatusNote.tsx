import { useState } from "react";
import { IconX } from "./Icons.js";

export type StatusTone = "ok" | "err" | "warn";

export interface StatusMessage {
  tone: StatusTone;
  text: string;
}

/**
 * Inline outcome of the nearest action.
 *
 * Success stays quiet. Errors and warnings alert, and can be dismissed —
 * a stuck failure next to the thing you already read is noise, not a status.
 */
export function StatusNote({
  message,
  onDismiss,
}: {
  message: StatusMessage | null;
  onDismiss?: () => void;
}) {
  const identity = message ? `${message.tone}\0${message.text}` : null;
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);

  if (identity === null && hiddenFor !== null) {
    setHiddenFor(null);
  }

  if (!message || hiddenFor === identity) return null;

  const dismissible = message.tone !== "ok";
  return (
    <p
      className={`note note--${message.tone}`}
      role={message.tone === "err" ? "alert" : "status"}
    >
      <span>{message.text}</span>
      {dismissible ? (
        <button
          type="button"
          className="icon-btn note__dismiss"
          aria-label="Dismiss"
          onClick={() => {
            setHiddenFor(identity);
            onDismiss?.();
          }}
        >
          <IconX size={16} />
        </button>
      ) : null}
    </p>
  );
}
