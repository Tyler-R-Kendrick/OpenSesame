/**
 * A typed `MediaQueryList` for tests: it answers `matches` for the queries it
 * was given as true and fires `change` to whoever subscribed, so a pointer
 * that changes mid-session can be walked. Built on `EventTarget`, so no
 * member is asserted into place.
 */
export class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null =
    null;

  constructor(
    readonly media: string,
    private on: boolean,
  ) {
    super();
  }

  get matches(): boolean {
    return this.on;
  }

  /** Flip the answer and tell every subscriber. */
  set(on: boolean): void {
    this.on = on;
    this.dispatchEvent(new Event("change"));
  }

  addListener(listener: EventListener | null): void {
    if (listener) this.addEventListener("change", listener);
  }

  removeListener(listener: EventListener | null): void {
    if (listener) this.removeEventListener("change", listener);
  }
}

/** A `matchMedia` for which only `(pointer: coarse)` is true when `coarse`. */
export function matchMediaFor(
  coarse: boolean,
): (query: string) => FakeMediaQueryList {
  return (query) =>
    new FakeMediaQueryList(query, coarse && query.includes("pointer: coarse"));
}
