/**
 * Read the facts `decideFill` rules on from a live document.
 *
 * This is the only fill module that touches the DOM, and it only reads. It
 * measures what a person would see: the focused input (through open shadow
 * roots), its box against the viewport, its opacity multiplied through every
 * ancestor — an `opacity: 0` on `<html>` or a wrapper hides a field just as
 * well as one on the field — and whether the field is what the browser would
 * hit at its own centre, which is how an overlay drawn over it is caught.
 */
import type { FieldFacts, FieldKind, PageFacts } from "./guard";

const USERNAME_HINT = /user|login|email|account|identifier/i;

function tokens(value: string | null): string[] {
  return (value ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

/** What kind of login field `input` is, from its type and autocomplete. */
export function fieldKind(input: HTMLInputElement): FieldKind {
  const type = input.type.toLowerCase();
  const auto = tokens(input.getAttribute("autocomplete"));
  if (type === "password") {
    if (auto.includes("new-password")) return "new_password";
    if (auto.includes("one-time-code")) return "other";
    return "password";
  }
  if (type !== "text" && type !== "email" && type !== "tel") return "other";
  if (auto.includes("username") || auto.includes("email")) return "username";
  if (auto.includes("one-time-code")) return "other";
  if (type === "email") return "username";
  const named = `${input.name} ${input.id}`;
  return USERNAME_HINT.test(named) ? "username" : "other";
}

/** The focused element, following focus into open shadow roots. */
export function focusedInput(doc: Document): HTMLInputElement | null {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  const view = doc.defaultView;
  return view && active instanceof view.HTMLInputElement ? active : null;
}

/** `filter: opacity(x)` factors, as fractions; `none` is 1. */
function filterOpacity(filter: string): number {
  let factor = 1;
  for (const match of filter.matchAll(/opacity\(\s*([\d.]+)(%?)\s*\)/g)) {
    const value = Number.parseFloat(match[1] ?? "1");
    factor *= match[2] === "%" ? value / 100 : value;
  }
  return factor;
}

/** The element's parent, stepping out of a shadow root to its host. */
function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** Opacity as painted: the product over the element and every ancestor. */
export function effectiveOpacity(el: Element, view: Window): number {
  let opacity = 1;
  for (let node: Element | null = el; node; node = parentOf(node)) {
    const style = view.getComputedStyle(node);
    const own = Number.parseFloat(style.opacity);
    opacity *= (Number.isFinite(own) ? own : 1) * filterOpacity(style.filter);
  }
  return opacity;
}

/** Whether the browser's own hit test at the field's centre finds the field. */
function hitsSelf(input: HTMLInputElement, x: number, y: number): boolean {
  const root = input.getRootNode();
  const scope =
    root instanceof ShadowRoot || root instanceof Document ? root : null;
  return scope?.elementFromPoint(x, y) === input;
}

/** Whether a passkey is offered beside `input`: passkeys come first. */
export function passkeyOffered(input: HTMLInputElement): boolean {
  if (tokens(input.getAttribute("autocomplete")).includes("webauthn")) {
    return true;
  }
  const scope: ParentNode = input.form ?? input.ownerDocument;
  return scope.querySelector('input[autocomplete~="webauthn" i]') !== null;
}

export function fieldFacts(input: HTMLInputElement, view: Window): FieldFacts {
  const box = input.getBoundingClientRect();
  const rect = {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
  return {
    kind: fieldKind(input),
    rect,
    viewport: { width: view.innerWidth, height: view.innerHeight },
    opacity: effectiveOpacity(input, view),
    visibility: view.getComputedStyle(input).visibility,
    hitSelf: hitsSelf(
      input,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    ),
    disabled: input.disabled || input.readOnly,
  };
}

/** Everything `decideFill` needs about this frame, read now. */
export function pageFacts(view: Window): PageFacts {
  const input = focusedInput(view.document);
  return {
    isTopFrame: view === view.top,
    origin: view.location.origin,
    passkeyOffered: input ? passkeyOffered(input) : false,
    field: input ? fieldFacts(input, view) : null,
  };
}
