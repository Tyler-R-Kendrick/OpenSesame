/**
 * Put a value into a field the way typing would: through the native `value`
 * setter, then the `input` and `change` events frameworks listen for.
 *
 * The native setter matters. React and similar libraries shadow `value` on
 * the element to notice programmatic writes, and a plain assignment through
 * that shadow is swallowed; the prototype's setter is what the browser uses
 * for a keystroke. The value is not kept, logged or returned.
 */
export function writeValue(input: HTMLInputElement, value: string): void {
  const view = input.ownerDocument.defaultView;
  const setter = view
    ? Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")
        ?.set
    : undefined;
  input.focus({ preventScroll: true });
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  const InputEventCtor = view?.InputEvent ?? InputEvent;
  const EventCtor = view?.Event ?? Event;
  input.dispatchEvent(
    new InputEventCtor("input", {
      bubbles: true,
      composed: true,
      inputType: "insertReplacementText",
    }),
  );
  input.dispatchEvent(new EventCtor("change", { bubbles: true }));
}
