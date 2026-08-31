import { type ReactElement, Suspense, lazy } from "react";
import { IconSupport } from "../../components/Icons.js";
import { useGuideTarget } from "../registry/react.jsx";
import { useSupport } from "../session.js";

/**
 * The panel, the agent adapters, the guide runtime and Driver.js all live
 * behind this import. A vault that never asks for help pays for one button.
 */
const SupportPanel = lazy(() =>
  import("./SupportPanel.js").then((module) => ({
    default: module.SupportPanel,
  })),
);

/**
 * Support sits in the statusline beside the bell and the lock, because that
 * strip is the one piece of chrome present at every width and on every screen
 * — it is where this app already puts the things that are always true.
 *
 * There is deliberately no keyboard shortcut. Every free single key belongs to
 * the vault keymap in `lib/keymap.ts`, which owns the one global handler and
 * its guards; a second window listener here would duplicate those guards and
 * drift from them. Opening support from a key needs a registration in that
 * module, the way `?` already registers the keymap sheet.
 */
export function SupportLauncher(): ReactElement {
  const { view, support } = useSupport();
  const ref = useGuideTarget<HTMLButtonElement>("shell.support");
  // A walkthrough runs on the page, not in the panel, so a closed panel has to
  // keep saying that one is live — and offer the way back to its controls.
  const guiding =
    view.guide?.status === "running" ||
    view.guide?.status === "waiting" ||
    view.guide?.status === "paused";
  const label = guiding ? "Support — walkthrough in progress" : "Support";

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`cx__btn ${guiding ? "cx__btn--attn" : "cx__btn--off"}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        onClick={() => support.open()}
      >
        <IconSupport size={17} />
        <span className="cx__pip" aria-hidden="true" />
      </button>
      {view.open ? (
        <Suspense
          fallback={
            <div className="sheet-layer">
              <span className="scrim" />
            </div>
          }
        >
          <SupportPanel />
        </Suspense>
      ) : null}
    </>
  );
}
