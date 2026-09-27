/**
 * "Reset this browser?", on every lock screen — the front door, the vault
 * list and the unlock form. A quiet link opens the consequence and two keys:
 * erase everything the app keeps in this browser and start again as a first
 * visit, or keep it. Mostly for testing: a clean first run without digging
 * through the browser's own site-data settings. What goes, and what cannot,
 * is `lib/browser-reset.ts`.
 *
 * Erasing always leaves for a fresh document (`reset-browser-run.ts`); while
 * it runs the app is not drawn (`ResetGate`). Whatever a reset left behind
 * is shown by the fresh document (`ResetLeftNotice`).
 *
 * Deleting one vault stays where it was ("Forgotten how to unlock?"); this
 * is everything the app keeps here, every vault and sign-in with it.
 */

import { type RefObject, useEffect, useRef, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconTrash, IconX } from "../../components/Icons.js";
import { landFocus } from "../../lib/focus.js";
import { eraseAndLeave } from "./reset-browser-run.js";

type Phase = "closed" | "asking" | "erasing";

type KeyRef = RefObject<HTMLButtonElement | null>;

/** The question's two keys: erase, or keep it. */
function AskKeys({
  keepRef,
  busy,
  onErase,
  onKeep,
}: {
  keepRef: KeyRef;
  busy: boolean;
  onErase: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="actions">
      <IconKey
        label="Erase everything in this browser"
        danger
        disabled={busy}
        onClick={onErase}
      >
        <IconTrash size={16} />
      </IconKey>
      <IconKey
        label="Keep it"
        small
        keyRef={keepRef}
        disabled={busy}
        onClick={onKeep}
      >
        <IconX size={16} />
      </IconKey>
    </div>
  );
}

export function ResetBrowser() {
  const [phase, setPhase] = useState<Phase>("closed");
  const linkRef = useRef<HTMLButtonElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const was = useRef<Phase>("closed");

  // Opening lands on the safe key, and closing hands focus back to the link,
  // so the keyboard never falls to the page (AGENTS.md § Keyboard access).
  useEffect(() => {
    if (phase === "asking") landFocus(keepRef.current);
    else if (phase === "closed" && was.current !== "closed") {
      landFocus(linkRef.current);
    }
    was.current = phase;
  }, [phase]);

  function erase(): void {
    setPhase("erasing");
    void eraseAndLeave();
  }

  if (phase === "closed") {
    return (
      <button
        ref={linkRef}
        type="button"
        className="unlock__switch"
        onClick={() => setPhase("asking")}
      >
        Reset this browser?
      </button>
    );
  }

  const busy = phase === "erasing";
  return (
    <fieldset
      className="unlock__danger"
      aria-label="Reset this browser"
      aria-busy={busy}
      onKeyDown={(event) => {
        // Only the question closes: once erasing has begun, what is gone
        // is gone.
        if (event.key === "Escape" && phase === "asking") {
          event.stopPropagation();
          setPhase("closed");
        }
      }}
    >
      <p>
        Resetting erases every vault, sign-in and setting this app keeps in this
        browser, then starts again as a first visit. Anything not backed up
        elsewhere is gone.
      </p>
      <AskKeys
        keepRef={keepRef}
        busy={busy}
        onErase={erase}
        onKeep={() => setPhase("closed")}
      />
    </fieldset>
  );
}
