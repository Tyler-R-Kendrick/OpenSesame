/**
 * The persistent callout `annotate` leaves on screen.
 *
 * Deliberately hand-built rather than borrowed from Driver.js: an annotation
 * outlives the step that placed it, so it must never be a dialog, never take
 * the caret and never sit between the person and the control it points at.
 * The text is model-authored, so it reaches the document through `textContent`
 * and nothing else — there is no markup path in this file.
 */

import type { GuideSide } from "@opensesame/guide-lang";

export const ANNOTATION_ATTRIBUTE = "data-os-guide-annotation";

const ANNOTATION_CLASS = "os-guide-annotation";
const GUIDE_CLASS = "os-guide";
const DEFAULT_SIDE: GuideSide = "bottom";

/** Distance from the control, in CSS pixels. */
const GAP = 10;

export type GuideAnnotationRequest = {
  readonly target: HTMLElement;
  /** Untrusted model prose. Written as text, never parsed. */
  readonly message: string;
  readonly side: GuideSide | null;
};

export type GuideAnnotation = {
  readonly node: HTMLElement;
  /** Detaches the node and every listener it registered. */
  readonly remove: () => void;
};

function place(node: HTMLElement, target: HTMLElement, side: GuideSide): void {
  const rect = target.getBoundingClientRect();
  const top = rect.top + window.scrollY;
  const left = rect.left + window.scrollX;

  if (side === "top") {
    node.style.top = `${top}px`;
    node.style.left = `${left}px`;
    node.style.transform = `translateY(calc(-100% - ${GAP}px))`;
    return;
  }
  if (side === "left") {
    node.style.top = `${top}px`;
    node.style.left = `${left}px`;
    node.style.transform = `translateX(calc(-100% - ${GAP}px))`;
    return;
  }
  if (side === "right") {
    node.style.top = `${top}px`;
    node.style.left = `${left + rect.width}px`;
    node.style.transform = `translateX(${GAP}px)`;
    return;
  }
  node.style.top = `${top + rect.height}px`;
  node.style.left = `${left}px`;
  node.style.transform = `translateY(${GAP}px)`;
}

export function createGuideAnnotation(
  request: GuideAnnotationRequest,
): GuideAnnotation {
  const side = request.side ?? DEFAULT_SIDE;

  const node = document.createElement("div");
  node.className = `${GUIDE_CLASS} ${ANNOTATION_CLASS} ${ANNOTATION_CLASS}--${side}`;
  node.setAttribute(ANNOTATION_ATTRIBUTE, "");
  // `note` is a non-modal landmark: it announces, it does not take the caret,
  // and it carries no `aria-modal`, so the page behind it stays operable.
  node.setAttribute("role", "note");

  const text = document.createElement("span");
  text.className = `${ANNOTATION_CLASS}__text`;
  text.textContent = request.message;
  node.appendChild(text);

  document.body.appendChild(node);

  const reposition = () => place(node, request.target, side);
  reposition();
  // Capture-phase scroll so the callout tracks a scrolling pane, not only the
  // window — an annotation that drifts off its control is worse than none.
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  return {
    node,
    remove: () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      node.remove();
    },
  };
}
