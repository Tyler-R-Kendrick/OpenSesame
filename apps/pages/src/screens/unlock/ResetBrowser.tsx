/**
 * "Reset this browser?", on every lock screen — the vault list and
 * the unlock form. A quiet link opens the consequence in a sheet:
 * erase everything the app keeps in this browser and start again
 * as a first visit, or keep it. Mostly for testing: a clean first
 * run without digging through the browser's own site-data settings.
 * What goes, and what cannot, is `lib/browser-reset.ts`.
 *
 * The sheet is the shape every irreversible act wears: its mark, its
 * name and its close key in the head; one card naming the place that
 * is erased, with the facts that justify it — how many vaults go,
 * what comes after, what is untouched; and the erase key — the `.go`
 * square in the error ink with its verb beside it — next to the Keep
 * key, where the keyboard lands. No warning wash, no kicker, and no
 * caption in a foot: an ask has not failed, and the facts already say
 * what a sentence would (`design-lint` `ask-is-not-alarm`,
 * `sheet-caption`).
 *
 * Erasing always leaves for a fresh document (`reset-browser-run.ts`);
 * while it runs the app is not drawn (`ResetGate`). Whatever a reset
 * left behind is shown by the fresh document (`ResetLeftNotice`).
 *
 * Deleting one vault stays where it was ("Forgotten how to unlock?");
 * this is everything the app keeps here, every vault and sign-in
 * with it.
 */

import { pagesPublicBase } from "@opensesame/app-core/lib/site-broker.js";
import { briefOrigin } from "@opensesame/os-domain";
import { type RefObject, useRef, useState } from "react";
import { useDeviceVaults } from "../../bindings/vaults.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { IconTrash, IconX } from "../../components/Icons.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import { eraseAndLeave } from "./reset-browser-run.js";

type Phase = "closed" | "asking" | "erasing";

export function ResetBrowser() {
  const [phase, setPhase] = useState<Phase>("closed");
  const sheetRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);

  const open = phase !== "closed";
  const busy = phase === "erasing";
  // Once erasing has begun, what is gone is gone: every way out of
  // the sheet — its safe key, its scrim, Escape — is spent.
  const onClose = () => {
    if (!busy) setPhase("closed");
  };

  // The sheet owns the keyboard while it is open: the safe key is
  // where focus lands, Tab stays inside, and closing hands focus
  // back to the question (AGENTS.md § Keyboard access).
  useModalFocus(open, sheetRef, keepRef, onClose);

  function erase(): void {
    setPhase("erasing");
    void eraseAndLeave();
  }

  return (
    <>
      <button
        type="button"
        className="unlock__switch"
        onClick={(event) => {
          // A real browser focuses a button the moment it is
          // pressed; jsdom does not. Say it here, so the sheet
          // that opens knows where to return the keyboard —
          // in this test and on the device alike.
          event.currentTarget.focus();
          setPhase("asking");
        }}
      >
        Reset this browser?
      </button>
      {open ? (
        <ResetBrowserSheet
          busy={busy}
          erase={erase}
          keepRef={keepRef}
          onClose={onClose}
          sheetRef={sheetRef}
        />
      ) : null}
    </>
  );
}

/** The consequence, in the shared sheet frame. */
function ResetBrowserSheet({
  busy,
  erase,
  keepRef,
  onClose,
  sheetRef,
}: {
  busy: boolean;
  erase: () => void;
  keepRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  sheetRef: RefObject<HTMLDivElement | null>;
}) {
  const vaults = useDeviceVaults().filter((vault) => vault.state !== "empty");
  return (
    <div
      className="sheet-layer"
      // Escape is spent at the layer, before it can reach the
      // screen behind the sheet.
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and paints a blank top-layer surface
        role="dialog"
        aria-label="Reset this browser"
        aria-modal="true"
      >
        <div className="sheet__head">
          <span className="sheet__mark" aria-hidden="true">
            <IconTrash size={20} />
          </span>
          <div className="sheet__grow">
            <h2>Reset this browser</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            title="Close"
            disabled={busy}
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">
          <CeremonyShell
            name={briefOrigin(pagesPublicBase())}
            facts={[
              { key: "Vaults", value: String(vaults.length) },
              { key: "With them", value: "sign-ins, settings" },
              { key: "After", value: "a first visit" },
              { key: "Untouched", value: "backups, other devices" },
            ]}
            primary={{
              label: "Erase this browser",
              tone: "danger",
              busy,
              onClick: erase,
            }}
            secondary={{
              label: "Keep it",
              busy,
              keyRef: keepRef,
              onClick: onClose,
            }}
          />
        </div>
      </div>
    </div>
  );
}
