import { resolveGuideTargetElement } from "@opensesame/app-core/tutorial/registry/targets.js";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { contextMenuOpen, statusBubbleOpen } from "../../lib/keymap-targets.js";
import type { SupportController } from "../session.js";

/** How long a step change glides, matching `--coach-glide` in the stylesheet. */
const GLIDE_MS = 300;

/** A text field's Escape is the field's own way out; anything else is ours. */
function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement &&
        !["button", "checkbox", "radio", "submit"].includes(target.type)))
  );
}

/**
 * Whose Escape it is. The card always exits the tour; from anywhere else a
 * sheet, drawer, menu or status bubble that is open takes the key first, so
 * one press closes one thing and the topmost surface goes before the tour.
 */
function surfaceOwnsEscape(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest(".coach__card")) return false;
  return (
    contextMenuOpen() ||
    statusBubbleOpen() ||
    document.querySelector(".sheet, .drawer") !== null
  );
}

/**
 * Someone is typing in the page, outside the Support UI that starts a tour
 * (its panel, its launcher). A browser agent can start a tour with no gesture
 * at all; the card must not take the caret from a field it did not open from.
 */
function typingElsewhere(held: Element | null): boolean {
  return (
    held !== null &&
    editable(held) &&
    held.closest('[aria-label="Support"], .support-launch') === null
  );
}

/**
 * The aperture glides between steps, then tracks the control instantly: a
 * transition on every frame would make the lit box lag a scrolling pane.
 */
export function useGlide(stepKey: string): boolean {
  const [gliding, setGliding] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new step is the trigger.
  useEffect(() => {
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    setGliding(true);
    const timer = setTimeout(() => setGliding(false), GLIDE_MS);
    return () => clearTimeout(timer);
  }, [stepKey]);
  return gliding;
}

/**
 * Focus belongs to the card when a tour opens and again when it closes — to
 * whatever held it before, never to the page body. In between it moves only
 * if it was already ours: a person typing in the lit control keeps their caret.
 * The card is `visibility: hidden` until it has been measured and placed, and
 * a hidden control cannot take focus, so the first move waits for the placing.
 */
export function useCoachFocus(
  placed: boolean,
  stepKey: string,
  card: RefObject<HTMLElement | null>,
  primary: RefObject<HTMLButtonElement | null>,
): void {
  useEffect(() => {
    const before = document.activeElement;
    return () => {
      const home =
        before instanceof HTMLElement && before.isConnected
          ? before
          : resolveGuideTargetElement("shell.support");
      home?.focus({ preventScroll: true });
    };
  }, []);
  const arrived = useRef(false);
  // Whose hands were last on the page: the card's, or somewhere else. A step
  // that navigates makes the page move focus on arrival (the vault lands it on
  // its tree); that is the page, not the person, so the card takes it back
  // unless the person's last input went outside the card.
  const lastInputInCard = useRef(true);
  useEffect(() => {
    const note = (event: Event): void => {
      lastInputInCard.current =
        event.target instanceof Node &&
        (card.current?.contains(event.target) ?? false);
    };
    document.addEventListener("pointerdown", note, true);
    document.addEventListener("keydown", note, true);
    return () => {
      document.removeEventListener("pointerdown", note, true);
      document.removeEventListener("keydown", note, true);
    };
  }, [card]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new step, or the first placing, is the trigger.
  useEffect(() => {
    if (!placed) return;
    const held = document.activeElement;
    if (!arrived.current && typingElsewhere(held)) {
      // A start with no gesture in the Support UI: leave the caret where the
      // person is working, and do not claim it on a later step either.
      lastInputInCard.current = false;
    } else if (
      !arrived.current ||
      held === document.body ||
      card.current?.contains(held) ||
      lastInputInCard.current
    ) {
      primary.current?.focus({ preventScroll: true });
    }
    arrived.current = true;
  }, [stepKey, placed]);
}

/**
 * Escape leaves the tour from anywhere except a text field or under an open
 * sheet. Capture phase, and the shell keymap stands down for it, so listener
 * order cannot decide: a tour that Escape cannot leave is a trap.
 */
export function useEscapeToExit(support: SupportController): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.isComposing || editable(event.target)) return;
      if (surfaceOwnsEscape(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      support.stopGuide();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [support]);
}

/**
 * Arrows step the tour only while the caret is in the card, so they never
 * take a key the page's own keymap (vim motions, the tree) is waiting for.
 */
export function cardKeys(
  support: SupportController,
  canBack: boolean,
): (event: ReactKeyboardEvent<HTMLElement>) => void {
  return (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      support.nextStep();
    } else if (event.key === "ArrowLeft" && canBack) {
      event.preventDefault();
      support.backStep();
    }
  };
}
