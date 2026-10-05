import { type ReactElement, Suspense, lazy } from "react";
import { createPortal } from "react-dom";
import { IconHelp } from "../../components/Icons.js";
import { useGateSeat } from "../gate-seat.js";
import { useGuideTarget } from "../registry/react.jsx";
import { useSupport } from "../session.js";
import "../support.css";
import { useSupportMarkSlot } from "./SupportComposer.js";

export {
  SupportComposer,
  SupportSlot,
  SupportSlotProvider,
} from "./SupportComposer.js";

/**
 * The panel, the agent adapters, the guide runtime and Driver.js all live
 * behind this import. A vault that never asks for help pays for one button.
 */
const SupportPanel = lazy(() =>
  import("./SupportPanel.js").then((module) => ({
    default: module.SupportPanel,
  })),
);

/** Tutorial mode: only fetched once a tour has a step to draw. */
const CoachHud = lazy(() =>
  import("../coach/CoachHud.js").then((module) => ({
    default: module.CoachHud,
  })),
);

const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "waiting",
  "paused",
]);

function markClass(chrome: boolean, guiding: boolean, open: boolean): string {
  return [
    "support-launch",
    chrome ? "support-launch--chrome icon-btn" : "",
    guiding ? "support-launch--live" : "",
    open ? "support-launch--open" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The question mark. On an unlocked shell it sits in the statusline beside
 * CommandBar. A gate (ADR 0165) has no statusline: it sits in the seat the
 * screen drew in its own chrome row and, with no seat drawn, it is not drawn
 * at all — never a floating square over a screen's controls.
 */
export function SupportLauncher({
  gate = false,
}: { gate?: boolean }): ReactElement {
  const { view, support } = useSupport();
  const statusline = useSupportMarkSlot();
  const seat = useGateSeat();
  const slot = gate ? seat : statusline;
  const ref = useGuideTarget<HTMLButtonElement>("shell.support");
  const chrome = slot !== null;
  const guiding = LIVE_STATUSES.has(view.guide?.status ?? "");
  const touring = view.guide?.tour != null;
  const label = guiding ? "Support — tutorial in progress" : "Support";

  const mark = (
    <button
      ref={ref}
      type="button"
      className={markClass(chrome, guiding, view.open)}
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      aria-expanded={view.open}
      tabIndex={view.open ? -1 : undefined}
      onClick={() => (view.open ? support.close() : support.open())}
    >
      <IconHelp size={chrome && !gate ? 15 : 18} />
    </button>
  );

  return (
    <>
      {slot ? createPortal(mark, slot) : gate ? null : mark}
      {touring ? (
        <Suspense fallback={null}>
          <CoachHud />
        </Suspense>
      ) : null}
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
