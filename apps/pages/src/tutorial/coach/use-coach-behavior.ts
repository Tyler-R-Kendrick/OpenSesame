import { resolveGuideTargetElement } from "@opensesame/app-core/tutorial/registry/targets.js";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
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
    if (
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
 * Escape leaves the tour from anywhere except a text field. Capture phase:
 * the app's own handlers are on the window too, and a tour that Escape cannot
 * leave is a trap.
 */
export function useEscapeToExit(support: SupportController): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.isComposing || editable(event.target)) return;
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
