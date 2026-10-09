// The push worker, in a real browser, over a real HTTP origin.
//
// Approving "Push notifications" is the person's consent to the push variant
// of the service worker. This walks that consent the way a person gives it —
// front door, guest, Settings › Capabilities, the capability's switch — on a
// device that already holds the core worker, and proves what the unit tests
// cannot: that the browser ends up running `sw-push.js` over the same scope,
// that nothing reloaded under the person on the way, that it is the only
// registration, and that a push the browser hands the worker becomes the
// doorbell `src/lib/push.ts` describes. Then the switch goes off and the core
// worker comes back.
//
// Why not `context.route`: a service worker's own fetches bypass page route
// interception, and the shared harness blocks workers outright. This serves
// `dist/` from a real localhost socket, exactly as a static host would, and
// lets workers run.
//
// What is stood in for: nothing in the page. The push itself is delivered
// through CDP `ServiceWorker.deliverPushMessage`, which is what the browser
// does after it has received and decrypted a message from its push service
// (headless Chromium has no FCM to subscribe against). The payload is the
// contract `{ kind, action, ref }` (`src/lib/push.ts`, `src/sw/push-handlers.ts`).
//
// Build first, with the base this serves:
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages

import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "@playwright/test";
import {
  capabilityOffSwitch,
  capabilityOnSwitch,
  capabilitySwitch,
} from "./lib/always-on.mjs";
import { doorGuest } from "./lib/front-door.mjs";
import {
  addCapabilities,
  openSettingsCategory,
  waitOpen,
} from "./lib/pages-journey.mjs";
import {
  notificationsOf as notificationsFrom,
  sameScript as same,
  scriptsOf as scriptsFrom,
  serve as serveDist,
  trackControlledBirth,
  until,
  untilBornControlled,
  untilWorkerHeld,
} from "./lib/push-worker-harness.mjs";

const dist = path.resolve(import.meta.dirname, "../dist");
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const TITLE = "Push notifications";
const REF = "rv_Ab12-Cd34";
const REF_AFTER = "rv_After-0001";

const failures = [];
const check = (condition, what) => {
  console.log(condition ? "PASS" : "FAIL", what);
  if (!condition) failures.push(what);
};

// Push notifications are the person's to approve only where something can
// answer a push: with no Identity API Settings does not offer the switch
// (ADR 0158, ADR 0162), so this deployment names one. It is never called: the
// walk proves the worker, and the push is delivered to the browser directly.
const server = await serveDist(dist, base, {
  identityApi: "http://127.0.0.1:9",
});
const origin = `http://localhost:${server.address().port}`;
const scope = `${origin}${base}`;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined,
  headless: true,
});
let exit = 0;
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "allow",
  });
  await context.grantPermissions(["notifications"], { origin });
  // Headless Chromium has no push service to subscribe against, so what the
  // browser holds is stood in for: `getSubscription` answers from this state,
  // and `unsubscribe` is counted. The app's own code is what calls both.
  const shim = { held: false, unsubscribed: 0 };
  await context.exposeBinding("__pushShim", (_source, op) => {
    if (op === "held") return shim.held;
    if (op === "unsubscribe") {
      shim.held = false;
      shim.unsubscribed += 1;
      return true;
    }
    return null;
  });
  await context.addInitScript(() => {
    PushManager.prototype.getSubscription = async () =>
      (await window.__pushShim("held"))
        ? {
            endpoint: "https://push.shim.example/endpoint",
            unsubscribe: () => window.__pushShim("unsubscribe"),
          }
        : null;
  });
  await trackControlledBirth(context);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error?.message)));
  // `performance.timeOrigin` is fixed for the life of a document and changes
  // with every load, so it says whether the person's page was replaced
  // (in-app route changes also fire `framenavigated`, which would not).
  const documentOrigin = () => page.evaluate(() => performance.timeOrigin);

  // CDP is how a pushed message reaches a worker once the browser has it.
  const cdp = await context.newCDPSession(page);
  const registrations = new Map();
  cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => {
    for (const r of event.registrations) registrations.set(r.registrationId, r);
  });
  await cdp.send("ServiceWorker.enable");
  const deliver = async (payload) => {
    const registration = [...registrations.values()].find(
      (r) => r.scopeURL === scope,
    );
    assert.ok(registration, `CDP knows no registration for ${scope}`);
    await cdp.send("ServiceWorker.deliverPushMessage", {
      origin,
      registrationId: registration.registrationId,
      data: JSON.stringify(payload),
    });
  };

  /** Wait for `script` to hold this scope for the page, with no help. */
  const untilHeld = (script, what) => untilWorkerHeld(page, base, script, what);

  /**
   * Deliver until `ok` holds of what the registration shows, as a push service
   * redelivers what a worker that was starting up missed. Returns what it
   * showed and how long the attempt that worked took; the tag makes a repeat
   * replace the notification rather than add one.
   */
  const ringUntil = async (payload, ok, what) => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const sentAt = Date.now();
      await deliver(payload);
      try {
        const list = await until(
          () => notificationsFrom(page),
          ok,
          what,
          attempt === 5 ? 15_000 : 3_000,
        );
        return { list, ms: Date.now() - sentAt };
      } catch (error) {
        if (attempt === 5) throw error;
      }
    }
    return { list: [], ms: 0 };
  };

  // A device that has only met the front door holds the core worker.
  await page.goto(scope);
  const core = `${scope}sw.js`;
  // The first install reloads the page once, by design; the door is not
  // touched until that reload has happened (`untilBornControlled`).
  await untilBornControlled(page);
  await until(
    () => scriptsFrom(page, base),
    (s) => same(s.active, core) && same(s.controller, core),
    "the core worker should be active and controlling after first load",
  );
  await doorGuest(page).waitFor({ timeout: 20_000 });
  await doorGuest(page).click();
  await waitOpen(page);
  // The first install reloads the page once, by design; count from here.
  await page.waitForTimeout(500);
  const documentBefore = await documentOrigin();
  let state = await scriptsFrom(page, base);
  check(
    same(state.active, core),
    "before approval the scope runs the core worker",
  );

  // A second tab of the same origin, with its own unlocked vault. It does
  // nothing below; the other tab's approval must not reload or lock it.
  const other = await context.newPage();
  other.on("pageerror", (error) => pageErrors.push(String(error?.message)));
  await other.goto(scope);
  await untilBornControlled(other);
  await until(
    () => scriptsFrom(other, base),
    (s) => same(s.controller, core),
    "the second tab should be controlled by the core worker",
  );
  await other.getByRole("button", { name: "Continue as guest" }).click();
  await waitOpen(other);
  await other.waitForTimeout(500);
  const otherBefore = await other.evaluate(() => performance.timeOrigin);
  const otherStillOpen = async () =>
    (await other.getByRole("button", { name: "Lock vault" }).first().count()) >
      0 && (await other.evaluate(() => performance.timeOrigin)) === otherBefore;
  check(await otherStillOpen(), "a second tab is open with its own vault");

  // The core worker has no push handler: a push to it shows no doorbell. This
  // is only meaningful beside the positive control below, which delivers the
  // same payload the same way once the push worker holds the scope.
  await deliver({ kind: "authorization_request", action: "review", ref: REF });
  await page.waitForTimeout(1500);
  check(
    (await notificationsFrom(page)).length === 0,
    "the core worker shows nothing for a push (it has no handler); control below",
  );

  // Approve Push notifications the way a person does.
  await addCapabilities(page, [TITLE]);
  state = await untilHeld(
    `${scope}sw-push.js`,
    "approving Push notifications should install and hand the page to sw-push.js",
  );
  check(
    state.registrations === 1,
    "there is exactly one registration (no competing worker)",
  );
  check(
    state.waiting === null && state.installing === null,
    "nothing is left installing or waiting",
  );
  check(
    (await documentOrigin()) === documentBefore,
    "the page was not reloaded under the person",
  );
  check(
    (await page.getByRole("button", { name: "Lock vault" }).first().count()) >
      0,
    "the vault is still open: the in-flight page survived the worker change",
  );
  const otherState = await until(
    () => scriptsFrom(other, base),
    (s) => same(s.controller, `${scope}sw-push.js`),
    "the second tab should be handed to the push worker too",
  );
  check(
    same(otherState.controller, `${scope}sw-push.js`),
    "the second tab is controlled by the push worker",
  );
  // Give a wrongly scheduled reload time to happen before asserting it did not.
  await other.waitForTimeout(3000);
  check(
    await otherStillOpen(),
    "the second tab neither reloaded nor locked its vault when the first approved",
  );

  // The doorbell: a decrypted push becomes the notification the contract says.
  const { list: shown, ms: ringMs } = await ringUntil(
    { kind: "authorization_request", action: "review", ref: REF },
    (list) => list.some((n) => n.data?.ref === REF),
    "the push worker should show the pushed message",
  );
  // How long the same delivery path takes to ring bounds how long silence must
  // last before it means something.
  console.log(`control: the same delivery rang the push worker in ${ringMs}ms`);
  const bell = shown.find((n) => n.data?.ref === REF);
  check(
    bell.title === "Authorization requested",
    `the doorbell title is ${JSON.stringify(bell.title)}`,
  );
  check(
    bell.body === "Open OpenSesame to review it.",
    "the doorbell body is the closed 'review' text",
  );
  check(bell.data?.ref === REF, "the doorbell carries the opaque reference");
  check(
    bell.tag === `opensesame-approval-${REF}`,
    "the doorbell is tagged by its reference",
  );

  // A hostile payload cannot put its own words on a lock screen.
  // The generic doorbell is the one tagged without a reference.
  const { list: hostile } = await ringUntil(
    {
      kind: "authorization_request",
      action: "review",
      ref: "../x",
      title: "Your password is hunter2",
      authorizationDetails: { secret: "x" },
    },
    (list) => list.some((n) => n.tag === "opensesame-approval"),
    "a malformed push should still ring the generic doorbell",
  );
  check(
    hostile.every((n) => !JSON.stringify(n).includes("hunter2")) &&
      hostile.find((n) => n.tag === "opensesame-approval")?.data?.ref === "",
    "a hostile payload yields the generic doorbell, with no reference and none of its text",
  );

  // A reload keeps the push worker: booting with the capability already
  // approved registers nothing new.
  await page.reload();
  state = await until(
    () => scriptsFrom(page, base),
    (s) =>
      same(s.active, `${scope}sw-push.js`) &&
      same(s.controller, `${scope}sw-push.js`),
    "after a reload the push worker should still hold the scope",
  );
  check(
    state.registrations === 1,
    "a reload with the capability approved leaves one registration",
  );

  // Taking the capability away reverts to the core worker. A load locks the
  // vault, so come back in as the guest the walk began as.
  await page.getByRole("button", { name: "Continue as guest" }).click();
  await waitOpen(page);
  await openSettingsCategory(page, "Capabilities");
  await capabilityOnSwitch(page, TITLE).waitFor({ timeout: 15_000 });
  // The browser holds a push subscription made under the push worker.
  shim.held = true;
  const documentAtRevert = await documentOrigin();
  const otherAtRevert = await other.evaluate(() => performance.timeOrigin);
  const unsubscribedBefore = shim.unsubscribed;
  // The same robust waits as `addCapabilities`: removal commits in place, so a
  // review that stays up is a failure of this walk, not something to click past.
  await capabilitySwitch(page, TITLE).click();
  await page
    .getByTestId("capability-review")
    .waitFor({ state: "detached", timeout: 15_000 });
  await capabilityOffSwitch(page, TITLE).waitFor({ timeout: 15_000 });
  state = await untilHeld(
    core,
    "removing Push notifications should return the scope to the core worker",
  );
  check(state.registrations === 1, "reverting leaves one registration");
  check(
    (await documentOrigin()) === documentAtRevert,
    "reverting did not reload the page",
  );
  await until(
    async () => shim.unsubscribed,
    (count) => count > unsubscribedBefore,
    "reverting should drop the subscription the push worker held",
  );
  // Each tab's controller follows the plan and may ask; the second ask finds
  // nothing to drop. What matters is that it was dropped, and only after the
  // scope was back on the core worker (waited for above).
  check(
    shim.unsubscribed > unsubscribedBefore && shim.held === false,
    "reverting dropped the browser's push subscription once the core worker held the scope",
  );
  await other.waitForTimeout(3000);
  check(
    same((await scriptsFrom(other, base)).controller, core) &&
      (await other.evaluate(() => performance.timeOrigin)) === otherAtRevert &&
      (await other
        .getByRole("button", { name: "Lock vault" })
        .first()
        .count()) > 0,
    "the second tab neither reloaded nor locked when the capability was removed",
  );
  // Silence beside the control above: wait several times as long as the push
  // worker took to ring for the identical delivery.
  await deliver({
    kind: "authorization_request",
    action: "review",
    ref: REF_AFTER,
  });
  await page.waitForTimeout(Math.max(1500, ringMs * 4));
  check(
    (await notificationsFrom(page)).every((n) => n.data?.ref !== REF_AFTER),
    "after reverting, the core worker again shows nothing for a push (control above: the push worker did)",
  );

  check(pageErrors.length === 0, `no page errors (${pageErrors.join(" | ")})`);
  if (failures.length > 0) exit = 1;
} catch (error) {
  console.error(error);
  exit = 1;
} finally {
  await browser.close();
  server.close();
}
if (exit !== 0) {
  console.error(`FAILED:\n${failures.map((f) => ` - ${f}`).join("\n")}`);
}
process.exit(exit);
