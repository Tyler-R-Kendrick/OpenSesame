/**
 * "Reset this browser?", on every lock screen — the front door, the vault
 * list and the unlock form. A quiet link opens the consequence and two keys:
 * erase everything the app keeps in this browser and start again as a first
 * visit, or keep it. Mostly for testing: a clean first run without digging
 * through the browser's own site-data settings. What goes, and what cannot,
 * is `lib/browser-reset.ts`.
 *
 * A reset that leaves something behind — a store that refused, or the
 * offline shell kept while the network does not answer — does not leave as
 * if it were clean: the panel stays, names what remains, and offers the two
 * ways on, erase again or start as a first visit anyway.
 *
 * Deleting one vault stays where it was ("Forgotten how to unlock?"); this
 * is everything the app keeps here, every vault and sign-in with it.
 */

import {
  type BrowserResetReport,
  resetBrowser,
} from "@opensesame/app-core/lib/browser-reset.js";
import { type RefObject, useEffect, useRef, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import {
  IconArrowRight,
  IconRefresh,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { landFocus } from "../../lib/focus.js";
import { scopePathOf, scopePrefix } from "../../sw/cache-names.js";
import { ResetBrowserLeft, leftBehind } from "./ResetBrowserLeft.js";

/**
 * The app's own scope and caches. The origin is shared with other sites, so
 * the reset removes only the worker registered at this scope and the caches
 * its worker names under it (`sw/cache-names.ts`, PWA-04).
 */
function resetThisBrowser(): Promise<BrowserResetReport> {
  const scope = new URL(import.meta.env.BASE_URL, window.location.href).href;
  const prefix = scopePrefix(scopePathOf(scope));
  return resetBrowser({ scope, ownsCache: (name) => name.startsWith(prefix) });
}

/** Replaceable in tests: jsdom cannot navigate. */
export const resetBrowserSeams = {
  reset: resetThisBrowser,
  /** A first visit lands on the app's root, not the deep link it was on. */
  firstVisit: () => window.location.replace(import.meta.env.BASE_URL),
};

type Phase = "closed" | "asking" | "erasing" | "left";

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

/** After a reset that left something: erase again, or start over anyway. */
function LeftKeys({
  againRef,
  onAgain,
  onFirstVisit,
}: {
  againRef: KeyRef;
  onAgain: () => void;
  onFirstVisit: () => void;
}) {
  return (
    <div className="actions">
      <IconKey label="Erase again" danger keyRef={againRef} onClick={onAgain}>
        <IconRefresh size={16} />
      </IconKey>
      <IconKey label="Start as a first visit" small onClick={onFirstVisit}>
        <IconArrowRight size={16} />
      </IconKey>
    </div>
  );
}

export function ResetBrowser() {
  const [phase, setPhase] = useState<Phase>("closed");
  const [report, setReport] = useState<BrowserResetReport | null>(null);
  const linkRef = useRef<HTMLButtonElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const againRef = useRef<HTMLButtonElement | null>(null);
  const was = useRef<Phase>("closed");

  // Opening lands on the safe key, a reset that left something lands on
  // erasing again, and closing hands focus back to the link — the keyboard
  // never falls to the page (AGENTS.md § Keyboard access).
  useEffect(() => {
    if (phase === "asking") landFocus(keepRef.current);
    else if (phase === "left") landFocus(againRef.current);
    else if (phase === "closed" && was.current !== "closed") {
      landFocus(linkRef.current);
    }
    was.current = phase;
  }, [phase]);

  async function erase(): Promise<void> {
    setPhase("erasing");
    const result = await resetBrowserSeams.reset();
    if (!leftBehind(result)) {
      resetBrowserSeams.firstVisit();
      return;
    }
    setReport(result);
    setPhase("left");
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
        // is gone, and the panel says what remains.
        if (event.key === "Escape" && phase === "asking") {
          event.stopPropagation();
          setPhase("closed");
        }
      }}
    >
      {phase === "left" && report ? (
        <ResetBrowserLeft report={report} />
      ) : (
        <p>
          Resetting erases every vault, sign-in and setting this app keeps in
          this browser, then starts again as a first visit. Anything not backed
          up elsewhere is gone.
        </p>
      )}
      {phase === "left" ? (
        <LeftKeys
          againRef={againRef}
          onAgain={() => void erase()}
          onFirstVisit={() => resetBrowserSeams.firstVisit()}
        />
      ) : (
        <AskKeys
          keepRef={keepRef}
          busy={busy}
          onErase={() => void erase()}
          onKeep={() => setPhase("closed")}
        />
      )}
    </fieldset>
  );
}
