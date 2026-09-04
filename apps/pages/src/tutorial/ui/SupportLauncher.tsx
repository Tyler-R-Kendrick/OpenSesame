import {
  type ReactElement,
  type ReactNode,
  Suspense,
  createContext,
  lazy,
  useContext,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { IconHelp } from "../../components/Icons.js";
import { useGuideTarget } from "../registry/react.jsx";
import { useSupport } from "../session.js";
import "../support.css";

/**
 * The panel, the agent adapters, the guide runtime and Driver.js all live
 * behind this import. A vault that never asks for help pays for one button.
 */
const SupportPanel = lazy(() =>
  import("./SupportPanel.js").then((module) => ({
    default: module.SupportPanel,
  })),
);

type SupportSlotApi = {
  slot: HTMLElement | null;
  setSlot: (node: HTMLElement | null) => void;
};

const noopSetSlot = (_node: HTMLElement | null): void => {};

const SupportSlotContext = createContext<SupportSlotApi>({
  slot: null,
  setSlot: noopSetSlot,
});

/** Shares the statusline seat with the launcher. Wrap the shell and launcher. */
export function SupportSlotProvider({
  children,
}: {
  children?: ReactNode;
}): ReactElement {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ slot, setSlot }), [slot]);
  return (
    <SupportSlotContext.Provider value={value}>
      {children}
    </SupportSlotContext.Provider>
  );
}

/** Empty seat on the statusline. The launcher portals the mark into it. */
export function SupportSlot(): ReactElement {
  const { setSlot } = useContext(SupportSlotContext);
  return <span ref={setSlot} className="statusline__support" />;
}

/**
 * The question mark. On an unlocked shell it sits in the statusline, the same
 * strip as the planes, the bell and the lock. Unlock, setup and the broker
 * have no statusline, so it falls back to a fixed corner overlay.
 *
 * There is deliberately no keyboard shortcut. Every free single key belongs to
 * the vault keymap in `lib/keymap.ts`, which owns the one global handler and
 * its guards; a second window listener here would duplicate those guards and
 * drift from them. Opening support from a key needs a registration in that
 * module, the way `?` already registers the keymap sheet.
 */
export function SupportLauncher(): ReactElement {
  const { view, support } = useSupport();
  const { slot } = useContext(SupportSlotContext);
  const ref = useGuideTarget<HTMLButtonElement>("shell.support");
  const chrome = slot !== null;
  // A walkthrough runs on the page, not in the panel, so a closed panel has to
  // keep saying that one is live — and offer the way back to its controls.
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
