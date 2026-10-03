/**
 * The flat tree a browser paints and a person sees, read from the DOM: shadow
 * roots entered, slots followed, and the places a page can hide a root from
 * script named instead of guessed at.
 *
 * A content script may ask for a closed root through
 * `browser.dom.openOrClosedShadowRoot` (the `RootReader` the entrypoint passes
 * in). Where it is absent a custom
 * element that exposes no open root is treated as hiding one.
 */
const PASSKEY_FIELD = 'input[autocomplete~="webauthn" i]';

/**
 * How a content script asks a host for the root its page closed, `null` where
 * the browser offers no way to ask.
 */
export type RootReader = (el: Element) => ShadowRoot | null;

/** The root a host holds, open or closed where `roots` can ask. */
export function shadowRootOf(
  el: Element,
  roots: RootReader | null,
): ShadowRoot | null {
  return el.shadowRoot ?? roots?.(el) ?? null;
}

function hidesRoot(el: Element, roots: RootReader | null): boolean {
  if (el.shadowRoot) return false;
  return roots ? roots(el) !== null : el.localName.includes("-");
}

/**
 * Whether where `el` is painted can be read: a light-DOM child of a host whose
 * root the page hid has no `assignedSlot`, so the wrappers that fade or cover
 * it are out of sight.
 */
export function slotObservable(el: Element, roots: RootReader | null): boolean {
  const parent = el.parentElement;
  return !(parent && !el.assignedSlot && hidesRoot(parent, roots));
}

/**
 * The element's parent in the flat tree: the slot a light-DOM child is
 * assigned to, else the DOM parent, stepping out of a shadow root to its host.
 */
export function flatParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** Whether `el` and every flat-tree ancestor above it can be read. */
export function treeObservable(el: Element, roots: RootReader | null): boolean {
  for (let node: Element | null = el; node; node = flatParent(node)) {
    if (!slotObservable(node, roots)) return false;
  }
  return true;
}

/**
 * Where a passkey beside `input` may be: its form, as the flat tree has it,
 * else the outermost shadow host it sits under, else its document.
 */
export function passkeyScope(input: HTMLInputElement): Element | Document {
  if (input.form) return input.form;
  let outermost: Element | null = null;
  for (let node: Element | null = input; node; node = flatParent(node)) {
    if (node.localName === "form") return node;
    const root = node.getRootNode();
    if (!node.parentElement && root instanceof ShadowRoot) {
      outermost = root.host;
    }
  }
  return outermost ?? input.ownerDocument;
}

function holdsPasskey(scope: ParentNode, roots: RootReader | null): boolean {
  if (scope.querySelector(PASSKEY_FIELD)) return true;
  for (const el of scope.querySelectorAll("*")) {
    const root = shadowRootOf(el, roots);
    if (root && holdsPasskey(root, roots)) return true;
  }
  return false;
}

/** Whether a webauthn field is in `scope`, its descendants' roots entered. */
export function scopeOffersPasskey(
  scope: Element | Document,
  roots: RootReader | null,
): boolean {
  if (holdsPasskey(scope, roots)) return true;
  const own = scope instanceof Element ? shadowRootOf(scope, roots) : null;
  return own !== null && holdsPasskey(own, roots);
}
