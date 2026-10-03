/**
 * `StepPages` over a jsdom page: the *real* page functions, evaluated inside
 * the page's own realm exactly as `scripting.executeScript` would run them —
 * from their source text, with nothing of this module in scope. A function that
 * reached for a helper outside its own body would throw here, as it would in a
 * tab.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { JSDOM } from "jsdom";
import { originOf } from "../origin";
import {
  pfFill,
  pfLayout,
  pfMask,
  pfPresence,
  pfReadDom,
  pfSubmit,
  pfUnmask,
  pfWaitFor,
} from "../page-fns";
import type { Capture, Landed, StepPages } from "../ports";
import type { Site } from "./site";

export class Browser {
  /** Whether a private window can be opened. */
  privateAllowed = true;
  /** Private windows opened and closed, so a test can see them cleaned up. */
  readonly privateWindows = { opened: 0, closed: 0 };
  /** The main tab's pages, for assertions on what was left in it. */
  main: JsdomPages | null = null;
  constructor(readonly site: Site) {}
}

export class JsdomPages implements StepPages {
  dom: JSDOM;
  path = "about:blank";
  signedIn: boolean;
  closed = false;
  /** Called between a mask and a still, to move the layout under it. */
  moveBeforeStill: (() => void) | null = null;
  /** Clicks on the page's submit control, so a test can count a double submit. */
  submitCount = 0;

  constructor(
    private readonly browser: Browser,
    private readonly origin: string,
    signedIn: boolean,
  ) {
    this.signedIn = signedIn;
    this.dom = new JSDOM("<html><body></body></html>", {
      runScripts: "outside-only",
      url: "about:blank",
    });
  }

  private load(path: string) {
    const url = new URL(path, this.origin);
    this.path = url.pathname + url.search;
    this.dom = new JSDOM(
      this.browser.site.render(url.pathname, this.signedIn, url.search),
      {
        runScripts: "outside-only",
        url: url.toString(),
      },
    );
    const win = this.dom.window;
    win.document.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.target;
      if (!(form instanceof win.HTMLFormElement)) return;
      this.submitCount += 1;
      const fields = Object.fromEntries(
        Array.from(form.querySelectorAll("input"), (input) => [
          input.name,
          input.value,
        ]),
      );
      const next = this.browser.site.submit(url.pathname, fields);
      if (next === "/login?ok=1") this.signedIn = true;
      this.load(next);
    });
  }

  /** Run a page function inside the page's realm, from its source text. */
  private async run<A extends BoundaryValue[], R>(
    fn: (...args: A) => R,
    ...args: A
  ) {
    // SAFETY: the evaluated source is the page function's own text, so its type matches that signature.
    const inPage = this.dom.window.eval(`(${fn.toString()})`) as (...a: A) => R;
    // SAFETY: awaiting the page function's return matches its declared result type.
    return (await inPage(...args)) as Awaited<R>;
  }

  /** Every URL the browser was asked to load. A real tab loads whatever it is told. */
  readonly requested: string[] = [];

  async navigate(url: string) {
    this.requested.push(url);
    this.load(url);
    // As the real adapter does: it loads, then reports where the tab ended up.
    return originOf(url) === this.origin
      ? ("ok" as const)
      : ("navigation" as const);
  }
  async waitFor(selector: string, timeoutMs = 50): Promise<Landed> {
    return await this.run(pfWaitFor, selector, timeoutMs);
  }
  fill(selector: string, value: string) {
    return this.run(pfFill, selector, value);
  }
  presence(selector: string, expected: string) {
    return this.run(pfPresence, selector, expected);
  }
  submit(selector: string) {
    return this.run(pfSubmit, selector);
  }
  readDom(strip: string[]) {
    return this.run(pfReadDom, strip);
  }
  layout() {
    return this.run(pfLayout);
  }
  async capture(maskSelectors: string[]): Promise<Capture | null> {
    const covered = await this.run(pfMask, maskSelectors);
    const before = await this.run(pfLayout);
    this.moveBeforeStill?.();
    const after = await this.run(pfLayout);
    await this.run(pfUnmask);
    return { image: new Uint8Array([1, 2, 3]), covered, before, after };
  }
  async fresh() {
    if (!this.browser.privateAllowed) return null;
    this.browser.privateWindows.opened += 1;
    return new JsdomPages(this.browser, this.origin, false).asPrivate();
  }
  private asPrivate(): JsdomPages {
    const original = this.close.bind(this);
    this.close = async () => {
      this.browser.privateWindows.closed += 1;
      await original();
    };
    return this;
  }
  async close() {
    this.closed = true;
  }
}
