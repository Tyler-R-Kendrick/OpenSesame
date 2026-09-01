/**
 * Driver.js behind the `GuideRenderer` port.
 *
 * Driver.js writes both popover slots with `innerHTML`, and every `message`
 * that reaches this adapter is model-authored text. So the model's string is
 * never put in a step at all: each popover is handed a fixed placeholder, and
 * the real prose is written with `textContent` from Driver's own
 * `onPopoverRender` hook — which runs after the markup sink and before the
 * popover is measured or shown. There is no path from a message to an HTML
 * parser, and no path from a `GuideTargetId` to a selector: the only way a
 * target becomes an element here is the injected `resolveElement`.
 *
 * Driver.js is loaded through a dynamic import so it stays out of the vault's
 * initial bundle, and none of its types cross this module's boundary.
 */

import type { GuideSide, GuideTargetId } from "@opensesame/guide-lang";
import type {
  GuideAnnotateRequest,
  GuideFocusRequest,
  GuideHintRequest,
  GuideRenderer,
  GuideScrollRequest,
} from "@opensesame/guide-runtime";
import { isFunction } from "@opensesame/os-domain";
import { type GuideAnnotation, createGuideAnnotation } from "./annotation.js";

/* ---------- the slice of Driver.js this adapter depends on ---------- */

/** The popover nodes Driver hands its render hook. Only what we write to. */
export type GuidePopoverNodes = {
  readonly wrapper: HTMLElement;
  readonly title: HTMLElement;
  readonly description: HTMLElement;
};

export type GuidePopoverButton = "next" | "previous" | "close";

export type GuidePopoverSpec = {
  /** Always the placeholder. The real text arrives via `onPopoverRender`. */
  description: string;
  side: GuideSide | undefined;
  showButtons: GuidePopoverButton[];
  popoverClass: string;
  onPopoverRender: (popover: GuidePopoverNodes) => void;
};

export type GuideDriverStep = {
  element: HTMLElement;
  popover: GuidePopoverSpec;
};

export type GuideDriverConfig = {
  animate: boolean;
  smoothScroll: boolean;
  allowClose: boolean;
  allowKeyboardControl: boolean;
  allowScroll: boolean;
  disableActiveInteraction: boolean;
  overlayClickBehavior: "close";
  overlayOpacity: number;
  stagePadding: number;
  stageRadius: number;
  popoverClass: string;
  showButtons: GuidePopoverButton[];
  onHighlighted: () => void;
};

export interface GuideDriverInstance {
  highlight: (step: GuideDriverStep) => void;
  destroy: () => void;
}

export type GuideDriverFactory = (
  config: GuideDriverConfig,
) => GuideDriverInstance;

export type GuideHintBeaconSpec = {
  side: GuideSide | undefined;
  animate: boolean;
  className: string;
};

export type GuideHintPopoverSpec = {
  description: string;
  side: GuideSide | undefined;
  showButton: boolean;
  popoverClass: string;
  onPopoverRender: (popover: GuidePopoverNodes) => void;
};

export type GuideHintSpec = {
  element: HTMLElement;
  id: string;
  beacon: GuideHintBeaconSpec;
  popover: GuideHintPopoverSpec;
};

export type GuideHintsConfig = {
  hints: GuideHintSpec[];
  overlay: boolean;
};

export interface GuideHintsInstance {
  show: () => void;
  hide: () => void;
  open: (id: string) => void;
}

export type GuideHintsFactory = (
  config: GuideHintsConfig,
) => GuideHintsInstance;

/* ---------- adapter ---------- */

export type DriverRendererOptions = {
  /** The registry's resolver. The only `GuideTargetId` → element edge. */
  readonly resolveElement: (id: GuideTargetId) => HTMLElement | null;
  readonly reducedMotion: () => boolean;
  /** Injected in tests; production leaves these out and the module is imported. */
  readonly driverFactory?: GuideDriverFactory;
  readonly hintsFactory?: GuideHintsFactory;
  /**
   * Told when a request names a target the registry cannot resolve. The
   * runtime fails the step on its own; this only records the miss.
   */
  readonly onMissingTarget?: (target: GuideTargetId) => void;
};

const GUIDE_CLASS = "os-guide";
const POPOVER_CLASS = "os-guide-popover";
const HINT_POPOVER_CLASS = "os-guide-hint-popover";
const HINT_BEACON_CLASS = "os-guide-beacon";
const DIALOG_LABEL = "Guide";
const OVERLAY_OPACITY = 0.45;
const STAGE_PADDING = 6;
const STAGE_RADIUS = 2;

/**
 * Stands in for the model's text inside the step Driver.js renders as HTML.
 * It has to be non-empty — Driver hides the description slot for a falsy
 * string — and it has to be inert, so it is one space and nothing else.
 */
const POPOVER_PLACEHOLDER = " ";

/**
 * The one place a message becomes visible. `textContent` assigns a single
 * text node; the string is never parsed, so markup in it stays markup-shaped
 * prose on screen.
 */
function writeMessage(nodes: GuidePopoverNodes, message: string): void {
  nodes.wrapper.classList.add(GUIDE_CLASS);
  // Driver points `aria-labelledby` at the title slot. Empty it and name the
  // dialog from authored text so no model string can become its label either.
  nodes.title.textContent = "";
  nodes.title.style.display = "none";
  nodes.wrapper.removeAttribute("aria-labelledby");
  nodes.wrapper.setAttribute("aria-label", DIALOG_LABEL);
  nodes.description.textContent = message;
  nodes.description.style.display = "block";
}

/**
 * Driver.js and its skin arrive together, in their own chunk. Nothing here is
 * reachable from a static import, so the vault's first paint never pays for a
 * tutorial the person may not open.
 */
async function importStyles(): Promise<void> {
  await Promise.all([
    import("driver.js/dist/driver.css"),
    import("driver.js/dist/hints.css"),
    import("./driver.css"),
  ]);
}

async function importDriverFactory(): Promise<GuideDriverFactory> {
  const [module] = await Promise.all([import("driver.js"), importStyles()]);
  return module.driver;
}

async function importHintsFactory(): Promise<GuideHintsFactory> {
  const [module] = await Promise.all([
    import("driver.js/hints"),
    importStyles(),
  ]);
  return module.hints;
}

export function createDriverRenderer(
  options: DriverRendererOptions,
): GuideRenderer {
  const drivers = new Set<GuideDriverInstance>();
  const hintGroups = new Set<GuideHintsInstance>();
  const annotations = new Set<GuideAnnotation>();
  let driverPromise: Promise<GuideDriverFactory> | null = null;
  let hintsPromise: Promise<GuideHintsFactory> | null = null;
  let hintSequence = 0;
  /**
   * Bumped by `clear`. Anything that awaited an import across a teardown
   * compares against it rather than attaching an overlay to a cleared page.
   */
  let era = 0;

  function driverFactory(): Promise<GuideDriverFactory> {
    const injected = options.driverFactory;
    if (injected) return Promise.resolve(injected);
    driverPromise ??= importDriverFactory();
    return driverPromise;
  }

  function hintsFactory(): Promise<GuideHintsFactory> {
    const injected = options.hintsFactory;
    if (injected) return Promise.resolve(injected);
    hintsPromise ??= importHintsFactory();
    return hintsPromise;
  }

  function resolve(target: GuideTargetId): HTMLElement | null {
    const element = options.resolveElement(target);
    if (element === null) options.onMissingTarget?.(target);
    return element;
  }

  async function focus(request: GuideFocusRequest): Promise<void> {
    const element = resolve(request.target);
    if (element === null) return;
    const opened = era;
    const create = await driverFactory();
    if (opened !== era) return;

    // One spotlight at a time — the runtime allows one live guide, so a later
    // step replaces the highlight instead of stacking a second overlay on it.
    dismissHighlights();

    const reduced = options.reducedMotion();
    const render = (nodes: GuidePopoverNodes) =>
      writeMessage(nodes, request.message);
    const instance = create({
      animate: !reduced,
      smoothScroll: !reduced,
      allowClose: true,
      allowKeyboardControl: true,
      allowScroll: true,
      // The highlighted control stays clickable: a guide points at the app,
      // it does not stand in for it.
      disableActiveInteraction: false,
      overlayClickBehavior: "close",
      overlayOpacity: OVERLAY_OPACITY,
      stagePadding: STAGE_PADDING,
      stageRadius: STAGE_RADIUS,
      popoverClass: `${GUIDE_CLASS} ${POPOVER_CLASS}`,
      // The close button is the keyboard-reachable way out of the highlight,
      // beside Escape and a click on the overlay.
      showButtons: ["close"],
      onHighlighted: () => {
        if (opened === era) handBackFocus(element);
      },
    });
    drivers.add(instance);
    instance.highlight({
      element,
      popover: {
        description: POPOVER_PLACEHOLDER,
        side: request.side ?? undefined,
        showButtons: ["close"],
        popoverClass: `${GUIDE_CLASS} ${POPOVER_CLASS}`,
        onPopoverRender: render,
      },
    });
    handBackFocus(element);
  }

  async function hint(request: GuideHintRequest): Promise<void> {
    const element = resolve(request.target);
    if (element === null) return;
    const opened = era;
    const create = await hintsFactory();
    if (opened !== era) return;

    hintSequence += 1;
    const id = `os-guide-hint-${hintSequence}`;
    const render = (nodes: GuidePopoverNodes) =>
      writeMessage(nodes, request.message);
    const group = create({
      overlay: false,
      hints: [
        {
          element,
          id,
          beacon: {
            side: request.side ?? undefined,
            animate: !options.reducedMotion(),
            className: HINT_BEACON_CLASS,
          },
          popover: {
            description: POPOVER_PLACEHOLDER,
            side: request.side ?? undefined,
            showButton: false,
            popoverClass: `${GUIDE_CLASS} ${HINT_POPOVER_CLASS}`,
            onPopoverRender: render,
          },
        },
      ],
    });
    hintGroups.add(group);

    // A hint is an aside. Whatever had the caret keeps it.
    const held = document.activeElement;
    group.show();
    group.open(id);
    if (held instanceof HTMLElement && document.activeElement !== held) {
      held.focus({ preventScroll: true });
    }
  }

  async function annotate(request: GuideAnnotateRequest): Promise<void> {
    const element = resolve(request.target);
    if (element === null) return;
    annotations.add(
      createGuideAnnotation({
        target: element,
        message: request.message,
        side: request.side,
      }),
    );
  }

  async function scroll(request: GuideScrollRequest): Promise<void> {
    const element = resolve(request.target);
    if (element === null) return;
    // Non-visual hosts (jsdom among them) ship no `scrollIntoView`; a guide
    // must not die because the page cannot scroll.
    if (!isFunction(element.scrollIntoView)) return;
    element.scrollIntoView({
      block: "center",
      behavior: options.reducedMotion() ? "auto" : "smooth",
    });
  }

  function dismissHighlights(): void {
    for (const instance of drivers) instance.destroy();
    drivers.clear();
  }

  function clear(): void {
    era += 1;
    dismissHighlights();
    for (const group of hintGroups) group.hide();
    hintGroups.clear();
    for (const annotation of annotations) annotation.remove();
    annotations.clear();
  }

  return { focus, hint, annotate, scroll, clear };
}

/**
 * Driver focuses the first focusable node in its own popover. Hand the caret
 * to the control the step is about, so acting on the guidance is one keypress
 * away and the page never ends up driven from an overlay.
 */
function handBackFocus(element: HTMLElement): void {
  element.focus({ preventScroll: true });
}

/**
 * The production entry point: Driver.js and its stylesheets arrive in their
 * own chunk, on first use of the tutorial surface.
 */
export async function loadDriverRenderer(
  options: DriverRendererOptions,
): Promise<GuideRenderer> {
  const [driver, hints] = await Promise.all([
    importDriverFactory(),
    importHintsFactory(),
  ]);
  return createDriverRenderer({
    ...options,
    driverFactory: options.driverFactory ?? driver,
    hintsFactory: options.hintsFactory ?? hints,
  });
}
