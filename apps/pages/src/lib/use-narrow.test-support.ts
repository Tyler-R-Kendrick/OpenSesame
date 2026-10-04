import { vi } from "vitest";

/**
 * A `MediaQueryList` that answers one question and listens to nothing: the
 * surface `useMediaQuery` reads (`matches`, and the change subscription).
 */
class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  onchange: MediaQueryList["onchange"] = null;

  constructor(
    readonly media: string,
    readonly matches: boolean,
  ) {
    super();
  }

  addListener(): void {}

  removeListener(): void {}
}

/** `window.matchMedia` for a device where a query holds when `holds` says so. */
export function stubMatchMedia(holds: (query: string) => boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      new FakeMediaQueryList(query, holds(query)),
  );
}

/** A device whose only pointer is a finger, or one with a mouse attached. */
export function stubPointer(fine: boolean): void {
  stubMatchMedia((query) => query.includes("any-pointer: fine") && fine);
}

/**
 * A screen by the two questions the shell asks of it: is it narrow
 * (`max-width: 900px`), and is its pointer a finger (`pointer: coarse`).
 */
export function stubScreen(screen: { narrow: boolean; coarse: boolean }): void {
  stubMatchMedia(
    (query) =>
      (screen.narrow && query.includes("max-width: 900px")) ||
      (screen.coarse && query.includes("pointer: coarse")),
  );
}
