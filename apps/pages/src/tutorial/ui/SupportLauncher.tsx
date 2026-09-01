import { type ReactElement, Suspense, lazy } from "react";
import { IconHelp } from "../../components/Icons.js";
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
 * Support is a fixed overlay in the same viewport corner on every screen —
 * unlock, setup, ceremonies, the broker popup, the vault. It is not chrome
 * of the unlocked shell, because those screens have no shell.
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
        className={`support-launch${guiding ? " support-launch--live" : ""}${view.open ? " support-launch--open" : ""}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={view.open}
        aria-hidden={view.open || undefined}
        tabIndex={view.open ? -1 : undefined}
        onClick={() => (view.open ? support.close() : support.open())}
      >
        <IconHelp size={18} />
      </button>
      {view.open ? (
        <Suspense
          fallback={
            <div className="sheet-layer">
              <button
                type="button"
                className="scrim"
                aria-label="Close"
                onClick={() => support.close()}
              />
            </div>
          }
        >
          <SupportPanel />
        </Suspense>
      ) : null}
    </>
  );
}
