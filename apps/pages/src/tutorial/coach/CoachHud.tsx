/**
 * Tutorial mode: the page dims, one control stays lit, and a card walks you
 * through it a step at a time.
 *
 * The runtime publishes every step as data — its text, the control it points
 * at, which side the author preferred, whether doing the thing also advances —
 * and this component only draws it. Everything a model or an author wrote
 * reaches the page as a React text node; nothing here parses markup, and a
 * control is found only through the target registry's own resolver (ADR 0088).
 *
 * It is not a modal. The page stays interactive through the aperture so a
 * step can say "your move" and mean it, the dim blocks nothing but stray
 * clicks, and Tab still leaves the card for the page. What it owns is the
 * keys that belong to a tour: Escape leaves it, and the arrow keys step it
 * while the caret is in the card.
 */

import { guideGoal } from "@opensesame/app-core/tutorial/registry/goals.js";
import type {
  GuideRuntimeSnapshot,
  GuideTourView,
} from "@opensesame/guide-runtime";
import { type CSSProperties, type ReactElement, useId, useRef } from "react";
import { type SupportController, useSupport } from "../session.js";
import "./coach.css";
import {
  CLOSING_TEXT,
  Dim,
  Foot,
  Head,
  Meter,
  Ring,
  counterOf,
} from "./CoachParts.js";
import type { placeCoach } from "./placement.js";
import {
  cardKeys,
  useCoachFocus,
  useEscapeToExit,
} from "./use-coach-behavior.js";
import { useCoachLayout } from "./use-coach-layout.js";

/** The notch's offset along the card edge, as the custom property coach.css reads. */
function notchStyle(px: number): CSSProperties & { "--coach-notch": string } {
  return { "--coach-notch": `${px}px` };
}

/** Where the card sits, as the inline style and classes the placement needs. */
type CardStyle = { readonly style: CSSProperties; readonly dock: string };

function cardStyle(placement: ReturnType<typeof placeCoach> | null): CardStyle {
  if (placement === null) return { style: { visibility: "hidden" }, dock: "" };
  if (placement.kind === "dock") {
    return { style: {}, dock: `coach__card--dock-${placement.edge}` };
  }
  return { style: { left: placement.left, top: placement.top }, dock: "" };
}

function titleOf(guide: GuideRuntimeSnapshot): string {
  return (guide.goal ? guideGoal(guide.goal)?.title : undefined) ?? "Tutorial";
}

/** The sentence, announced with its position for a listener who never sees the meter. */
function Narration({
  id,
  tour,
  counter,
}: { id: string; tour: GuideTourView; counter: string }): ReactElement {
  const closing = tour.kind === "close";
  return (
    <p className="coach__text" id={id} aria-live="polite">
      {counter && !closing ? (
        <span className="visually-hidden">{counter}. </span>
      ) : null}
      {tour.message ?? (closing ? CLOSING_TEXT : "")}
    </p>
  );
}

function Coach({
  guide,
  tour,
  support,
}: {
  guide: GuideRuntimeSnapshot;
  tour: GuideTourView;
  support: SupportController;
}): ReactElement {
  const titleId = useId();
  const bodyId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const closing = tour.kind === "close";
  const title = titleOf(guide);

  const layout = useCoachLayout(guide.runId, tour, cardRef);
  const { stepKey, viewport, hole, placement, gliding, missing } = layout;
  useCoachFocus(placement !== null, stepKey, cardRef, primaryRef);
  useEscapeToExit(support);

  const { style, dock } = cardStyle(placement);
  const facing = placement?.kind === "anchored" ? placement.facing : undefined;
  const notch = placement?.kind === "anchored" ? placement.notch : 0;
  const counter = counterOf(tour);

  return (
    <div
      className="coach"
      data-coach-step={tour.step}
      data-coach-kind={tour.kind}
      data-coach-target={tour.target ?? ""}
      data-coach-degraded={missing ? "true" : "false"}
    >
      <Dim hole={hole} viewport={viewport} gliding={gliding} />
      {hole !== null ? (
        <Ring hole={hole} gliding={gliding} action={tour.action} />
      ) : null}
      <section
        ref={cardRef}
        className={`coach__card ${dock} coach__card--${tour.kind}${placement ? " is-placed" : ""}`}
        style={style}
        // biome-ignore lint/a11y/useSemanticElements: a native <dialog open> would inert the page, and a tour must leave it live.
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-facing={facing}
        onKeyDown={cardKeys(support, tour.canBack)}
      >
        {facing !== undefined ? (
          <span
            className="coach__notch"
            style={notchStyle(notch)}
            aria-hidden="true"
          />
        ) : null}
        <Meter tour={tour} />
        <Head
          titleId={titleId}
          title={title}
          counter={counter}
          closing={closing}
          support={support}
        />
        <Narration id={bodyId} tour={tour} counter={counter} />
        <Foot
          tour={tour}
          missing={missing}
          support={support}
          primary={primaryRef}
        />
      </section>
    </div>
  );
}

/**
 * Draws the tour the runtime is on, or nothing. Keyed by run, so Replay from
 * the panel (a new run) re-enters from the first step with the entrance.
 */
export function CoachHud(): ReactElement | null {
  const { view, support } = useSupport();
  const guide = view.guide;
  const tour = guide?.tour ?? null;
  if (!guide || !tour) return null;
  return (
    <Coach key={guide.runId} guide={guide} tour={tour} support={support} />
  );
}
