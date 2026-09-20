import { type ReactElement, Suspense, lazy } from "react";
import { createPortal } from "react-dom";
import { IconHelp } from "../../components/Icons.js";
import { useGuideTarget } from "../registry/react.jsx";
import { useSupport } from "../session.js";
import "../support.css";
import {
  SupportSlot,
  SupportSlotProvider,
  useSupportMarkSlot,
} from "./SupportComposer.js";

export { SupportComposer, SupportSlot, SupportSlotProvider } from "./SupportComposer.js";

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
 * The question mark. On an unlocked shell it sits in the statusline beside
 * CommandBar. Unlock/setup have no statusline, so it falls back to a corner.
 */
export function SupportLauncher(): ReactElement {
  const { view, support } = useSupport();
  const slot = useSupportMarkSlot();
  const ref = useGuideTarget<HTMLButtonElement>("shell.support");
  const chrome = slot !== null;
  const guiding =
    view.guide?.status === "running" ||
    view.guide?.status === "waiting" ||
    view.guide?.status === "paused";
  const label = guiding ? "Support — walkthrough in progress" : "Support";

  const mark = (
    <button
      ref={ref}
      type="button"
      className={`support-launch${chrome ? " support-launch--chrome icon-btn" : ""}${guiding ? " support-launch--live" : ""}${view.open ? " support-launch--open" : ""}`}
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      aria-expanded={view.open}
      tabIndex={view.open ? -1 : undefined}
      onClick={() => (view.open ? support.close() : support.open())}
    >
      <IconHelp size={chrome ? 15 : 18} />
    </button>
  );

  return (
    <>
      {slot ? createPortal(mark, slot) : mark}
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
