/**
 * What the runner needs from the browser, as ports.
 *
 * The step logic never names `chrome.*`: it drives a `StepPages` and asks a
 * `Grants`, so the same logic runs under the real browser (`browser.ts`) and
 * under a jsdom page in the pact tests.
 */

/** A verdict from one page function; `invalid` is a selector that does not parse. */
export type Landed = "ok" | "timeout" | "invalid";

/** The page a run is driven in. Every operation is confined to the run's origin. */
export interface StepPages {
  /** Load `url` in the run's tab. `navigation` when it ended anywhere but the run's origin. */
  navigate(url: string): Promise<"ok" | "navigation" | "timeout">;
  waitFor(selector: string, timeoutMs?: number): Promise<Landed>;
  fill(
    selector: string,
    value: string,
  ): Promise<"ok" | "no_such_field" | "invalid">;
  presence(
    selector: string,
    expected: string,
  ): Promise<"present" | "absent" | "mismatch" | "invalid">;
  submit(selector: string): Promise<"ok" | "no_such_element" | "invalid">;
  /** Markup with values stripped. */
  readDom(strip: string[]): Promise<string>;
  /** The page's layout signature (see `pfLayout`). */
  layout(): Promise<string>;
  /**
   * A still with the selectors covered, or null when one cannot be taken that
   * the Host can store. `before` and `after` are layout signatures around it.
   */
  capture(maskSelectors: string[]): Promise<Capture | null>;
  /** A clean, private browsing context for `verify_login`; null when there is none. */
  fresh(): Promise<StepPages | null>;
  close(): Promise<void>;
}

export interface Capture {
  image: Uint8Array;
  /** How many of the requested selectors were covered. */
  covered: number;
  before: string;
  after: string;
}

import type { OriginalOwner } from "./original-owner";

/** The browser's per-origin grants. */
export interface Grants {
  /** Whether the browser still lets the runner act on `origin`. */
  has(origin: string, owner?: OriginalOwner): Promise<boolean>;
  /** Give the grant back. */
  revoke(origin: string, owner?: OriginalOwner): Promise<void>;
  /** Whether the person let this extension open a private window (for `verify_login`). */
  privateAllowed(owner?: OriginalOwner): Promise<boolean>;
}

/** A run, as far as the runner needs to know it. */
export interface RunRef {
  id: string;
  origin: string;
}

export type PagesFactory = (
  run: RunRef,
  owner?: OriginalOwner,
) => Promise<StepPages | null>;
