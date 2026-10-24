import { type ReactNode, createContext, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { NoticeCorner } from "./NoticeCorner.js";
import { ToastStack } from "./ToastStack.js";

const NoticeSeatContext = createContext<(node: HTMLDivElement | null) => void>(
  () => {},
);

/** A gate owns the flow region where its notices and bell are reachable. */
export function GateNoticeSeat() {
  const place = useContext(NoticeSeatContext);
  return <div className="gate-notice-seat" ref={place} />;
}

/**
 * A shellless screen keeps the bell in its own notice seat when it has one.
 * Other screens keep the flow fallback before their body. Moving the notice
 * surface never remounts the screen or changes the vault gate.
 */
export function Notices({
  shellless,
  children,
}: {
  shellless: boolean;
  children: ReactNode;
}) {
  const [seat, place] = useState<HTMLDivElement | null>(null);
  return (
    <NoticeSeatContext.Provider value={place}>
      {shellless ? (
        seat ? (
          createPortal(<NoticeCorner />, seat)
        ) : (
          <NoticeCorner />
        )
      ) : null}
      {children}
      {shellless ? <ToastStack /> : null}
    </NoticeSeatContext.Provider>
  );
}
