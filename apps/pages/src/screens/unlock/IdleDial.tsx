import { type ReactElement, type RefObject, useRef } from "react";
import { CipherDial } from "../../components/CipherDial/index.js";

export type IdleDial = {
  paneRef: RefObject<HTMLDivElement | null>;
  cardRef: RefObject<HTMLDivElement | null>;
  notesRef: RefObject<HTMLElement | null>;
  dial: ReactElement;
};

/**
 * The cipher dial at rest, for a gate that runs no ceremony (the front
 * door): the same rings and key as the unlock stage, laid out against the
 * gate's own pane, card and notes.
 */
export function useIdleDial(): IdleDial {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const notesRef = useRef<HTMLElement | null>(null);
  const dial = (
    <CipherDial
      paneRef={paneRef}
      cardRef={cardRef}
      notesRef={notesRef}
      phase="idle"
      alignStartMs={null}
      lit={0}
    />
  );
  return { paneRef, cardRef, notesRef, dial };
}
