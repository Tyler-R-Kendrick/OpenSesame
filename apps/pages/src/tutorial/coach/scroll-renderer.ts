/**
 * The renderer port, for a presentation that draws itself.
 *
 * A tour is drawn by `CoachHud`, a React component reading the runtime's own
 * snapshot — the step's text, its target id and its side are data the runtime
 * already publishes, so there is nothing for a renderer to put on the page and
 * no second place a message could become visible. What the port still owes
 * the runtime is the one thing a component cannot do from a snapshot: bring a
 * control that is off screen into view before the step is shown.
 *
 * A target becomes an element only through the injected `resolveElement`, the
 * registry's own resolver (ADR 0088 §3); this file never sees a selector.
 */

import type { GuideTargetId } from "@opensesame/guide-lang";
import type {
  GuideFocusRequest,
  GuideRenderer,
  GuideScrollRequest,
} from "@opensesame/guide-runtime";
import { isFunction } from "@opensesame/os-domain";

export type ScrollRendererOptions = {
  readonly resolveElement: (id: GuideTargetId) => HTMLElement | null;
  readonly reducedMotion: () => boolean;
};

const none = (_request: GuideFocusRequest): Promise<void> => Promise.resolve();

export function createScrollRenderer(
  options: ScrollRendererOptions,
): GuideRenderer {
  function scroll(request: GuideScrollRequest): Promise<void> {
    const element = options.resolveElement(request.target);
    // Non-visual hosts (jsdom among them) ship no `scrollIntoView`; a tour
    // must not die because the page cannot scroll.
    if (element !== null && isFunction(element.scrollIntoView)) {
      element.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: options.reducedMotion() ? "auto" : "smooth",
      });
    }
    return Promise.resolve();
  }
  return { focus: none, hint: none, annotate: none, scroll, clear: () => {} };
}
