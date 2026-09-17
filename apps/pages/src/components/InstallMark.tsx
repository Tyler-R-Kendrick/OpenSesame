import { useState } from "react";
import { useInstall } from "../lib/use-install.js";

/**
 * Compact install control for chrome, next to the wordmark.
 *
 * Chromium's dialog has to hang off a real gesture; this is that gesture.
 * iOS has no dialog a page may open, so the three-tap card stays in Settings.
 */
export function InstallMark() {
  const { state, visible, install } = useInstall();
  const [busy, setBusy] = useState(false);
  if (!visible || state !== "prompt") return null;

  return (
    <button
      type="button"
      className="btn btn--sm rail__install"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void install().finally(() => setBusy(false));
      }}
    >
      {busy ? "Installing…" : "Install OpenSesame"}
    </button>
  );
}
