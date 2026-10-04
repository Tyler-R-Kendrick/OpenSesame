/**
 * The harness `capture-evidence.mjs` drives. Two kinds:
 *
 *   - the default serves a build out of `dist/` at the production origin, with
 *     every request routed and service workers blocked: a static front end
 *     with no backend, which is what nearly every journey is evidence of;
 *   - `"stack": "push"` serves the build at a real localhost origin with
 *     service workers on, next to a real Identity API, the Host's Web Push
 *     delivery and a stand-in push service (`push-stack.mjs`), for the Push
 *     row, which exists only for a person signed in to an Identity API. The
 *     build must be stamped `loopback_development` for that origin
 *     (`pnpm --filter @opensesame/pages build:push-verify`, or the same
 *     steps into another directory for the base), and the capture runs under
 *     `tsx` because the stack imports the control-plane's TypeScript.
 *
 * Only the browser's own push subscription is stood in for
 * (`push-browser-shim.mjs`); nothing is drawn by hand.
 */

import path from "node:path";
import { chromium } from "@playwright/test";
import { installPushShim } from "./push-browser-shim.mjs";
import { PAGES_ORIGIN, startPushStack } from "./push-stack.mjs";
import { createHarness } from "./static-origin-harness.mjs";

/** The production origin, unless a journey shows what a dedicated deployment does. */
const STATIC_ORIGIN = "https://tyler-r-kendrick.github.io";

/** What a push page keeps of its session: the shim and the principal it was given. */
export const pushSessions = new WeakMap();

async function pushHarness({ dist, base }) {
  // What the deployment's `os-runtime-config.json` adds for the screen being
  // captured. Served by the stack itself: a request a service worker answers
  // never reaches `context.route`.
  let served = {};
  const stack = await startPushStack({
    dist,
    base,
    runtimeConfig: () => served,
  });
  const harness = {
    stack,
    launch: () =>
      chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
        headless: true,
      }),
    async newPage(browser, { device, screen } = {}) {
      served = screen?.runtimeConfig ?? {};
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        ...(device ?? {}),
        serviceWorkers: "allow",
      });
      await context.grantPermissions(["notifications"], {
        origin: PAGES_ORIGIN,
      });
      const shim = await installPushShim(context, () => stack.standIn.mint());
      const page = await context.newPage();
      const session = { shim, principal: null };
      // The anonymous session the page is given at boot, as the page got it.
      page.on("response", async (response) => {
        if (!response.url().endsWith("/v1/principals/provisional")) return;
        const body = await response.json().catch(() => null);
        if (body?.accessToken)
          session.principal = {
            bearer: body.accessToken,
            id: body.principalId,
          };
      });
      pushSessions.set(page, session);
      return { page, context };
    },
  };
  return { harness, origin: PAGES_ORIGIN, close: () => stack.close() };
}

/** The harness for this journey; `close` ends whatever it started. */
export async function openHarness({ journey, mode, dist, base, shots }) {
  const out = path.join(shots, ".log");
  if (mode === "capture" && journey.stack === "push")
    return pushHarness({ dist, base });
  const origin = process.env.EVIDENCE_ORIGIN ?? STATIC_ORIGIN;
  return {
    harness: createHarness({ dist, origin, base, out }),
    origin,
    close: async () => {},
  };
}
