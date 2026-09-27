/**
 * Erase this browser and leave. The one road both "Reset this browser?" and
 * the left-behind notice take: the reset (`lib/browser-reset.ts`), scoped to
 * the app's own worker and caches, then a fresh document at the app's root —
 * always, whatever the report says. The tab that reset has halted its
 * writes and remembers storage that is gone; it is never left to be used.
 * What was left behind rides the address to the fresh document
 * (`lib/browser-reset-landing.ts`).
 */

import { firstVisitAddress } from "@opensesame/app-core/lib/browser-reset-landing.js";
import {
  type BrowserResetReport,
  resetBrowser,
} from "@opensesame/app-core/lib/browser-reset.js";
import { scopePathOf, scopePrefix } from "../../sw/cache-names.js";

/**
 * The app's own scope and caches. The origin is shared with other sites, so
 * the reset removes only the worker registered at this scope and the caches
 * its worker names under it (`sw/cache-names.ts`, PWA-04).
 */
function resetThisBrowser(): Promise<BrowserResetReport> {
  const scope = new URL(import.meta.env.BASE_URL, window.location.href).href;
  const prefix = scopePrefix(scopePathOf(scope));
  return resetBrowser({ scope, ownsCache: (name) => name.startsWith(prefix) });
}

/** Replaceable in tests: jsdom cannot navigate. */
export const resetBrowserSeams = {
  reset: resetThisBrowser,
  /** A first visit lands on the app's root, not the deep link it was on. */
  leave: (report: BrowserResetReport) =>
    window.location.replace(
      firstVisitAddress(import.meta.env.BASE_URL, report),
    ),
};

export async function eraseAndLeave(): Promise<void> {
  const report = await resetBrowserSeams.reset();
  resetBrowserSeams.leave(report);
}
