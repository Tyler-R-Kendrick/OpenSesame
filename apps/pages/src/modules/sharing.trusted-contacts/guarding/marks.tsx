/**
 * The marks line of a card in a guardian's sheet: where it stands, and the one
 * sentence of a step that did not finish. A failure is never drawn as text in
 * the page; it is a mark on the card whose key failed (and a notice in the
 * tray, raised by `useCeremonyFailure`).
 */

import type { ReactNode } from "react";
import { StatusMark } from "../../../components/StatusMark.js";
import type { Mark } from "../row-model.js";

export function MarkLine({ children }: { children: ReactNode }) {
  return <div className="tc-row__marks">{children}</div>;
}

export function Marked({ mark }: { mark: Mark }) {
  return <StatusMark tone={mark.tone} label={mark.label} />;
}

/** The mark for a step's failure sentence; nothing while there is none. */
export function FailureMark({ message }: { message: string }) {
  return message ? <StatusMark tone="err" label={message} /> : null;
}
