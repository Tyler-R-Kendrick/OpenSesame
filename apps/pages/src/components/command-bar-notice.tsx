import { useEffect } from "react";
import { IconX } from "./Icons.js";

/** Success and failure notices clear on their own so the strip cannot cover the shell. */
const COMMAND_NOTICE_DISMISS_MS = 4000;

export function CommandBarNotice({
  notice,
  setNotice,
  open,
}: {
  notice: string | null;
  setNotice: (next: string | null) => void;
  open: boolean;
}) {
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, COMMAND_NOTICE_DISMISS_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice, setNotice]);

  useEffect(() => {
    if (notice === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setNotice(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [notice, setNotice]);

  if (notice === null || open) return null;

  return (
    <output className="command-bar__status" aria-live="polite">
      <span className="command-bar__status-text">{notice}</span>
      <button
        type="button"
        className="icon-btn command-bar__status-dismiss"
        aria-label="Dismiss command status"
        title="Dismiss"
        onClick={() => {
          setNotice(null);
        }}
      >
        <IconX size={14} />
      </button>
    </output>
  );
}
