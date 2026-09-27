/**
 * "Reset this browser?", on every lock screen — the front door, the vault
 * list and the unlock form. A quiet link opens the consequence and two keys:
 * erase everything the app keeps in this browser and start again as a first
 * visit, or keep it. Mostly for testing: a clean first run without digging
 * through the browser's own site-data settings. What goes, and what cannot,
 * is `lib/browser-reset.ts`.
 *
 * Deleting one vault stays where it was ("Forgotten how to unlock?"); this
 * is the whole origin, every vault and sign-in with it.
 */

import { resetBrowser } from "@opensesame/app-core/lib/browser-reset.js";
import { useEffect, useRef, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconTrash, IconX } from "../../components/Icons.js";
import { landFocus } from "../../lib/focus.js";

/** Replaceable in tests: jsdom cannot navigate. */
export const resetBrowserSeams = {
  reset: resetBrowser,
  /** A first visit lands on the app's root, not the deep link it was on. */
  firstVisit: () => window.location.replace(import.meta.env.BASE_URL),
};

export function ResetBrowser() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const linkRef = useRef<HTMLButtonElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);

  // Opening lands on the safe key; closing hands focus back to the link, so
  // the keyboard never falls to the page (AGENTS.md § Keyboard access).
  useEffect(() => {
    if (open) landFocus(keepRef.current);
    else if (wasOpen.current) landFocus(linkRef.current);
    wasOpen.current = open;
  }, [open]);

  async function erase(): Promise<void> {
    setBusy(true);
    // Every area is attempted and nothing throws; whatever could not be
    // removed, this tab's memory no longer matches storage, so it reloads.
    await resetBrowserSeams.reset();
    resetBrowserSeams.firstVisit();
  }

  if (!open) {
    return (
      <button
        ref={linkRef}
        type="button"
        className="unlock__switch"
        onClick={() => setOpen(true)}
      >
        Reset this browser?
      </button>
    );
  }

  return (
    <fieldset
      className="unlock__danger"
      aria-label="Reset this browser"
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <p>
        Resetting erases every vault, sign-in and setting this app keeps in this
        browser, then starts again as a first visit. Anything not backed up
        elsewhere is gone.
      </p>
      <div className="actions">
        <IconKey
          label="Erase everything in this browser"
          danger
          disabled={busy}
          onClick={() => void erase()}
        >
          <IconTrash size={16} />
        </IconKey>
        <IconKey
          label="Keep it"
          small
          keyRef={keepRef}
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          <IconX size={16} />
        </IconKey>
      </div>
    </fieldset>
  );
}
