/**
 * The content-side fill decision (ADR 0150 §6.4), pure: facts in, a verdict
 * out, no DOM and no clock of its own.
 *
 * A value is asked for only when every one of these holds, and each failure
 * is its own refusal so a test can name the attack it stops:
 *
 * - the gesture was made on extension-owned UI — the keyboard command or the
 *   popup's fill key — and is seconds old, never a page load or navigation;
 * - this is the top frame, and its origin is exactly the one the background
 *   resolved from the tab;
 * - the focused element is a login field (a current password, or a
 *   username), and no passkey is offered for it — passkeys first;
 * - that field is really there for a person to see: enabled, non-zero size,
 *   not `visibility: hidden`, not faded out through its own or an
 *   ancestor's opacity, inside the viewport, and the topmost element at its
 *   own centre. The last three are the DOM-based extension clickjacking
 *   primitives (Tóth, DEF CON 33, 2025): an invisible or covered field that
 *   a person's gesture fills without their knowing.
 */

/** The only gestures that may start a fill: both are outside the page. */
export const TRIGGERS = ["command", "popup"] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** A gesture older than this is not the one the person just made. */
export const GESTURE_WINDOW_MS = 10_000;

/** A field fainter than this is treated as hidden. */
export const MIN_OPACITY = 0.5;

export type FieldKind = "password" | "username" | "new_password" | "other";
export type FillField = "password" | "username";

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface FieldFacts {
  readonly kind: FieldKind;
  readonly rect: Rect;
  readonly viewport: { readonly width: number; readonly height: number };
  /** The field's opacity multiplied through every ancestor and filter. */
  readonly opacity: number;
  /** Computed `visibility`. */
  readonly visibility: string;
  /** `elementFromPoint` at the field's centre is the field itself. */
  readonly hitSelf: boolean;
  readonly disabled: boolean;
}

export interface PageFacts {
  readonly isTopFrame: boolean;
  /** `location.origin` of this document. */
  readonly origin: string;
  /** The field's form (or the page) advertises `autocomplete="webauthn"`. */
  readonly passkeyOffered: boolean;
  /** The focused input, or `null` when focus is not on an input. */
  readonly field: FieldFacts | null;
}

/** What the background sent when the person made the gesture. */
export interface Arm {
  readonly trigger: string;
  readonly origin: string;
  readonly armedAt: number;
}

export type Refusal =
  | "untrusted_trigger"
  | "stale_gesture"
  | "not_top_frame"
  | "origin_mismatch"
  | "no_focused_field"
  | "not_a_login_field"
  | "passkey_offered"
  | "disabled"
  | "zero_size"
  | "hidden"
  | "transparent"
  | "off_screen"
  | "covered";

export type Decision =
  | { readonly fill: true; readonly field: FillField }
  | { readonly fill: false; readonly refusal: Refusal };

const refuse = (refusal: Refusal): Decision => ({ fill: false, refusal });

function isTrigger(value: string): value is Trigger {
  return TRIGGERS.some((trigger) => trigger === value);
}

/** An http(s) origin in the browser's own serialization. */
export function isWebOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

function gestureRefusal(arm: Arm, now: number): Refusal | null {
  if (!isTrigger(arm.trigger)) return "untrusted_trigger";
  const age = now - arm.armedAt;
  if (!Number.isFinite(age) || age < 0 || age > GESTURE_WINDOW_MS) {
    return "stale_gesture";
  }
  return null;
}

function frameRefusal(arm: Arm, page: PageFacts): Refusal | null {
  if (!page.isTopFrame) return "not_top_frame";
  if (!isWebOrigin(page.origin) || page.origin !== arm.origin) {
    return "origin_mismatch";
  }
  return null;
}

function inViewport(field: FieldFacts): boolean {
  const { rect, viewport } = field;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return cx >= 0 && cy >= 0 && cx < viewport.width && cy < viewport.height;
}

/** Whether a person can actually see the field they are about to fill. */
export function visibilityRefusal(field: FieldFacts): Refusal | null {
  if (field.disabled) return "disabled";
  if (!(field.rect.width >= 1 && field.rect.height >= 1)) return "zero_size";
  if (field.visibility !== "visible") return "hidden";
  if (!(field.opacity >= MIN_OPACITY)) return "transparent";
  if (!inViewport(field)) return "off_screen";
  if (!field.hitSelf) return "covered";
  return null;
}

/** Decide whether this page, now, may ask the background for a value. */
export function decideFill(arm: Arm, page: PageFacts, now: number): Decision {
  const early = gestureRefusal(arm, now) ?? frameRefusal(arm, page);
  if (early) return refuse(early);
  const field = page.field;
  if (!field) return refuse("no_focused_field");
  if (field.kind !== "password" && field.kind !== "username") {
    return refuse("not_a_login_field");
  }
  if (page.passkeyOffered) return refuse("passkey_offered");
  const hidden = visibilityRefusal(field);
  return hidden ? refuse(hidden) : { fill: true, field: field.kind };
}
