/**
 * A page for suites that run where there is no window. Its listeners are kept
 * as the DOM keeps them: one per (type, listener, capture flag), so a remove
 * that names another flag removes nothing, and a second add of the same
 * triple is not a second listener. Everything else is inert.
 *
 * (Node's own `EventTarget` ignores a boolean capture flag on remove, so it is
 * not a faithful stand-in for the window here.)
 */

import type { PagePort } from "../../../ports.js";

const URL_OF_PAGE = new URL("https://opensesame.example.test/");

type Entry = Readonly<{
  type: string;
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
}>;

type ListenerOptions = boolean | EventListenerOptions | undefined;

function captureOf(options: ListenerOptions): boolean {
  if (options === undefined || options === false) return false;
  return options === true || options.capture === true;
}

export type TargetPage = Readonly<{
  page: PagePort;
  /** Deliver an event of `type` to every listener registered for it. */
  fire: (type: string) => void;
  /** How many listeners are registered, of any type. */
  listenerCount: () => number;
}>;

export function pageWithListeners(): TargetPage {
  let entries: readonly Entry[] = [];
  const same = (a: Entry, b: Entry): boolean =>
    a.type === b.type && a.listener === b.listener && a.capture === b.capture;

  const page: PagePort = {
    location: {
      origin: URL_OF_PAGE.origin,
      href: URL_OF_PAGE.href,
      protocol: URL_OF_PAGE.protocol,
      host: URL_OF_PAGE.host,
      hostname: URL_OF_PAGE.hostname,
      pathname: URL_OF_PAGE.pathname,
      search: URL_OF_PAGE.search,
      hash: URL_OF_PAGE.hash,
      assign() {},
      replace() {},
      reload() {},
    },
    opener: null,
    isSecureContext: true,
    visibilityState: "visible",
    addEventListener: (...args: Parameters<Window["addEventListener"]>) => {
      const [type, listener, options] = args;
      const entry = { type, listener, capture: captureOf(options) };
      if (!entries.some((held) => same(held, entry))) {
        entries = [...entries, entry];
      }
    },
    removeEventListener: (
      ...args: Parameters<Window["removeEventListener"]>
    ) => {
      const [type, listener, options] = args;
      const entry = { type, listener, capture: captureOf(options) };
      entries = entries.filter((held) => !same(held, entry));
    },
    open: () => null,
    close() {},
    replaceUrl() {},
    onVisibilityChange: () => () => {},
    startDownload() {},
    submitForm() {},
  };

  return {
    page,
    fire(type) {
      const event = new Event(type);
      for (const { listener } of entries.filter((held) => held.type === type)) {
        if ("handleEvent" in listener) listener.handleEvent(event);
        else listener(event);
      }
    },
    listenerCount: () => entries.length,
  };
}
