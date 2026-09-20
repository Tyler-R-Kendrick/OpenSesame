import { useState } from "react";
import { useInstall } from "../lib/use-install.js";
import type { IconProps } from "./Icons.js";

/**
 * App install, drawn like Chromium's own address-bar install glyph: a
 * monitor with a download arrow, because that is the control it duplicates.
 * Single use, so the glyph lives with its consumer rather than in Icons.
 */
function IconInstallApp({ className, title, size = 20 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      <rect x="3" y="4" width="18" height="12.5" rx="2" />
      <path d="M12 7v6.5M9.3 11L12 13.7l2.7-2.7" />
      <path d="M9 20.5h6M12 16.5v4" />
    </svg>
  );
}

/**
 * Compact install control for chrome, next to the wordmark.
 *
 * An icon key drawn like Chromium's own address-bar install glyph, because
 * that is the control this duplicates; the accessible name keeps the words.
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
      className="icon-btn rail__install"
      aria-label="Install OpenSesame"
      title="Install OpenSesame"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => {
        setBusy(true);
        void install().finally(() => setBusy(false));
      }}
    >
      <IconInstallApp size={17} />
    </button>
  );
}
