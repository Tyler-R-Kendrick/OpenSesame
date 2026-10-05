/**
 * The pieces of the tutorial card: the dim with its aperture, the meter, the
 * head and the foot. Each draws data the runtime already published and holds
 * no state of its own.
 */

import type { GuideTourView } from "@opensesame/guide-runtime";
import type { CSSProperties, ReactElement } from "react";
import { IconKey } from "../../components/IconKey.js";
import {
  IconAlert,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconSupport,
  IconX,
} from "../../components/Icons.js";
import type { SupportController } from "../session.js";
import type { Box } from "./placement.js";

/** How far the aperture stands off the control it lights. */
export const APERTURE_PAD = 6;

export const CLOSING_TEXT = "That is the whole tutorial.";

export function padded(box: Box): Box {
  return {
    left: box.left - APERTURE_PAD,
    top: box.top - APERTURE_PAD,
    width: box.width + APERTURE_PAD * 2,
    height: box.height + APERTURE_PAD * 2,
  };
}

/** The four panels of dim around an aperture; clicks on them do nothing. */
export function Dim({
  hole,
  viewport,
  gliding,
}: {
  hole: Box | null;
  viewport: { width: number; height: number };
  gliding: boolean;
}): ReactElement {
  const box = hole ?? {
    left: viewport.width / 2,
    top: viewport.height / 2,
    width: 0,
    height: 0,
  };
  const top = Math.max(0, box.top);
  const bottom = Math.max(top, box.top + box.height);
  const left = Math.max(0, box.left);
  const right = Math.max(left, box.left + box.width);
  const panel = (style: CSSProperties): ReactElement => (
    <div
      className={`coach__dim${gliding ? " is-gliding" : ""}`}
      style={style}
      aria-hidden="true"
    />
  );
  return (
    <>
      {panel({ top: 0, left: 0, width: "100%", height: top })}
      {panel({ top: bottom, left: 0, width: "100%", bottom: 0 })}
      {panel({ top, left: 0, width: left, height: bottom - top })}
      {panel({ top, left: right, right: 0, height: bottom - top })}
    </>
  );
}

export function Ring({
  hole,
  gliding,
  action,
}: {
  hole: Box;
  gliding: boolean;
  action: boolean;
}): ReactElement {
  return (
    <div
      className={`coach__ring${gliding ? " is-gliding" : ""}${action ? " is-action" : ""}`}
      style={{
        left: hole.left,
        top: hole.top,
        width: hole.width,
        height: hole.height,
      }}
      aria-hidden="true"
    />
  );
}

export function Meter({ tour }: { tour: GuideTourView }): ReactElement {
  const positions = Array.from(
    { length: Math.max(tour.count, 1) },
    (_, at) => at + 1,
  );
  return (
    <div className="coach__meter" aria-hidden="true">
      {positions.map((position) => {
        const state =
          tour.kind === "close" || position < tour.step
            ? "done"
            : position === tour.step
              ? "now"
              : "ahead";
        return (
          <span key={position} className={`coach__seg coach__seg--${state}`} />
        );
      })}
    </div>
  );
}

/** "Step 2 of 5", or "Complete" on the closing card. */
export function counterOf(tour: GuideTourView): string {
  if (tour.kind === "close") return "Complete";
  return tour.count > 0 ? `Step ${tour.step} of ${tour.count}` : "";
}

export function Head({
  titleId,
  title,
  counter,
  closing,
  support,
}: {
  titleId: string;
  title: string;
  counter: string;
  closing: boolean;
  support: SupportController;
}): ReactElement {
  return (
    <header className="coach__head">
      <span className="coach__mark" aria-hidden="true">
        {closing ? <IconCheck size={16} /> : <IconSupport size={16} />}
      </span>
      <h2 className="coach__title" id={titleId}>
        <span className="visually-hidden">Tutorial: </span>
        {title}
      </h2>
      <span className="coach__count">{counter}</span>
      <IconKey small label="Exit tutorial" onClick={() => support.stopGuide()}>
        <IconX size={15} />
      </IconKey>
    </header>
  );
}

function Cue({
  missing,
  action,
}: { missing: boolean; action: boolean }): ReactElement | null {
  if (missing) {
    return (
      <>
        <IconAlert size={14} />
        not on screen
      </>
    );
  }
  if (!action) return null;
  return (
    <>
      <span className="coach__pulse" aria-hidden="true" />
      your move
    </>
  );
}

export function Foot({
  tour,
  missing,
  support,
  primary,
}: {
  tour: GuideTourView;
  missing: boolean;
  support: SupportController;
  primary: React.Ref<HTMLButtonElement>;
}): ReactElement {
  const closing = tour.kind === "close";
  return (
    <footer className="coach__foot">
      <span className="coach__cue">
        <Cue missing={missing} action={tour.action} />
      </span>
      <div className="coach__keys">
        {closing ? (
          <button
            type="button"
            className="coach__btn"
            onClick={() => support.replayGuide()}
          >
            <IconRefresh size={15} />
            Replay
          </button>
        ) : (
          <button
            type="button"
            className="coach__btn"
            disabled={!tour.canBack}
            onClick={() => support.backStep()}
          >
            <IconChevronLeft size={15} />
            Back
          </button>
        )}
        <button
          ref={primary}
          type="button"
          className="coach__btn coach__btn--go"
          onClick={() => support.nextStep()}
        >
          {closing ? (
            <>
              Done
              <IconCheck size={15} />
            </>
          ) : (
            <>
              Next
              <IconChevronRight size={15} />
            </>
          )}
        </button>
      </div>
    </footer>
  );
}
