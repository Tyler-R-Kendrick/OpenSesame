// Web Push, end to end, in a real browser against a real Identity API.
//
//   Pages (dist-push-verify, loopback_development)  <-- Chromium, service workers on
//     |  approve Push notifications, turn push on / off
//     v
//   Identity API (control-plane startServer(), in memory)
//     ^  the Host's worker wiring delivers (createWorkerNotificationAdapters)
//     |
//   stand-in push service: verifies RFC 8292 VAPID, decrypts RFC 8291 aes128gcm
//
// Walked: approve the capability (the push worker takes the scope), enrol (the
// key is fetched, the subscription is recorded server-side under this
// principal), a real push is sent through the stand-in and handed to the
// worker the way the browser does after decrypting it (CDP
// `ServiceWorker.deliverPushMessage`) and rings the closed "Authorization
// requested" doorbell, then push is turned off and the server's row is gone.
// Then the failures a person can meet, each a notice in the tray and a row
// that still says Off: the Identity API cannot be reached, another principal
// holds this browser's endpoint (409, recovered with a fresh subscription),
// the principal is at its subscription limit (409, nothing left half-enrolled,
// no second subscription made to be taken back) and, on a second device, an
// operator policy that does not name the Identity API's origin (refused by this
// installation's own egress port before any request leaves).
//
// Stood in for: only the browser's subscription (headless Chromium has no push
// service; `lib/push-browser-shim.mjs` answers `subscribe`/`getSubscription`/
// `unsubscribe` with real subscriptions the stand-in can decrypt for).
//
// Build first:  pnpm --filter @opensesame/pages build:push-verify
// Run:          pnpm --filter @opensesame/pages verify:push   (under tsx: it
//               imports the control-plane's TypeScript)

import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "@playwright/test";
import { doorGuest } from "./lib/front-door.mjs";
import {
  addCapabilities,
  openSettingsCategory,
  waitOpen,
} from "./lib/pages-journey.mjs";
import { installPushShim } from "./lib/push-browser-shim.mjs";
import { policyWalk } from "./lib/push-policy-walk.mjs";
import { PAGES_ORIGIN, startPushStack } from "./lib/push-stack.mjs";
import { createRun } from "./lib/push-verify-kit.mjs";
import { notificationsOf, until } from "./lib/push-worker-harness.mjs";

const dist = path.resolve(import.meta.dirname, "../dist-push-verify");
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const scope = `${PAGES_ORIGIN}${base}`;
const TURN_ON = { name: "Turn on push on this device" };
const TURN_OFF = { name: "Turn off push on this device" };

const { check, step, finish } = createRun();

/** What the deployment's `os-runtime-config.json` adds; the last scenario sets it. */
let served = {};
const stack = await startPushStack({ dist, base, runtimeConfig: () => served });
const LIMIT = stack.limit;
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
  await context.grantPermissions(["notifications"], { origin: PAGES_ORIGIN });
  const shim = await installPushShim(context, () => stack.standIn.mint());
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error?.message)));
  let bearer = null;
  page.on("request", (request) => {
    if (request.url().startsWith(stack.api) && request.method() !== "OPTIONS") {
      const header = request.headers().authorization;
      if (header) bearer = header.replace(/^Bearer /i, "");
    }
  });

  /** The tray's notices about this row, read the way a person reads them. */
  const pushNotices = async () => {
    await page.getByRole("button", { name: /^Notifications — / }).click();
    const sheet = page.getByRole("dialog", { name: "Notifications" });
    await sheet.waitFor();
    const found = await sheet
      .locator(".notice-card")
      .filter({ hasText: "Push on this device" })
      .allInnerTexts();
    await sheet.getByRole("button", { name: "Close" }).first().click();
    await sheet.waitFor({ state: "detached" });
    return found;
  };
  const turnOn = () => page.getByRole("button", TURN_ON);
  const turnOff = () => page.getByRole("button", TURN_OFF);
  const rowIs = (state) =>
    until(
      async () => ({
        on: await turnOff().count(),
        off: await turnOn().count(),
      }),
      (seen) => (state === "On" ? seen.on === 1 : seen.off === 1),
      `the Push row to say ${state}`,
      15_000,
    );

  step(
    "front door, guest, approve Push notifications and Notification routing",
  );
  await page.goto(scope);
  await doorGuest(page).waitFor({ timeout: 20_000 });
  await doorGuest(page).click();
  await waitOpen(page);
  await addCapabilities(page, ["Push notifications", "Notification routing"]);
  await until(
    () =>
      page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        return r?.active?.scriptURL ?? null;
      }),
    (url) => url !== null && new URL(url).pathname.endsWith("/sw-push.js"),
    "the push worker to hold the scope",
    30_000,
  );
  check(true, "the push worker holds the scope once Push is approved");

  step("Settings > General: the Push row is offered, push is Off");
  await openSettingsCategory(page, "General");
  await turnOn().waitFor({ timeout: 15_000 });
  check(
    shim.subscribed.length === 0,
    "nothing is subscribed before the key is pressed",
  );

  // CDP is how a pushed message reaches a worker once the browser has it.
  const cdp = await context.newCDPSession(page);
  const registrations = new Map();
  cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => {
    for (const r of event.registrations) registrations.set(r.registrationId, r);
  });
  await cdp.send("ServiceWorker.enable");

  step("turn push on: key fetched, subscribed, recorded server-side");
  const asked = stack.standIn.received.length;
  await turnOn().click();
  await rowIs("On");
  assert.ok(bearer, "the app sent no bearer to the Identity API");
  const principal = { bearer, id: await stack.whoIs(bearer) };
  const held = await stack.live(principal.id);
  check(
    held.length === 1,
    `the Identity API holds one subscription for this principal (${held.length})`,
  );
  check(
    shim.subscribed.length === 1,
    "the browser made exactly one subscription",
  );
  check(
    held[0]?.endpoint === shim.subscribed[0]?.endpoint,
    "the server's record is the browser's subscription",
  );
  check(
    shim.keys[0] === stack.vapid.publicKey,
    "the browser subscribed with the key the Identity API serves",
  );
  check(
    stack.standIn.received.length === asked,
    "enrolling sends nothing to the push service",
  );
  check(
    (await pushNotices()).length === 0,
    "a successful turn-on leaves no notice",
  );

  step("a real push through the stand-in rings the closed doorbell");
  const rung = await stack.ring(principal);
  check(
    rung.push.json?.kind === "authorization_request" &&
      rung.push.json?.action === "review",
    `the Host sent the closed vocabulary (${JSON.stringify(rung.push.json)})`,
  );
  const ref = rung.push.json?.ref;
  check(Boolean(ref), "the push carries an opaque reference");
  check(
    rung.push.subscriptionId === shim.subscribed[0].id,
    "it went to this browser's subscription",
  );
  const registration = await until(
    async () => [...registrations.values()].find((r) => r.scopeURL === scope),
    (found) => Boolean(found),
    `CDP to know the registration for ${scope}`,
    10_000,
  );
  // A push service redelivers what a worker that was starting up missed.
  let bell = null;
  for (let attempt = 1; attempt <= 5 && bell === null; attempt += 1) {
    await cdp.send("ServiceWorker.deliverPushMessage", {
      origin: PAGES_ORIGIN,
      registrationId: registration.registrationId,
      data: JSON.stringify(rung.push.json),
    });
    try {
      const list = await until(
        () => notificationsOf(page),
        (shown) => shown.some((n) => n.data?.ref === ref),
        "the push worker to show the pushed message",
        attempt === 5 ? 15_000 : 3_000,
      );
      bell = list.find((n) => n.data?.ref === ref);
    } catch (error) {
      if (attempt === 5) throw error;
    }
  }
  check(
    bell.title === "Authorization requested",
    `the doorbell title is ${JSON.stringify(bell.title)}`,
  );
  check(
    bell.body === "Open OpenSesame to review it.",
    "the doorbell body is the closed 'review' text",
  );

  step("turn push off: the server's row is gone, the browser unsubscribed");
  await turnOff().click();
  await rowIs("Off");
  check(
    (await stack.live(principal.id)).length === 0,
    "the Identity API holds no subscription any more",
  );
  check(shim.unsubscribed.length === 1, "the browser's subscription was ended");
  check((await pushNotices()).length === 0, "turning off leaves no notice");

  step("failure: the Identity API cannot be reached");
  const subscribedBefore = shim.subscribed.length;
  await page.route(`${stack.api}/v1/notification-channels/push/key`, (route) =>
    route.abort("connectionrefused"),
  );
  await turnOn().click();
  const unreachable = await until(
    pushNotices,
    (found) => found.length === 1,
    "a notice that the service cannot be reached",
    10_000,
  );
  await page.unroute(`${stack.api}/v1/notification-channels/push/key`);
  check(
    /not reachable from here, so notifications were not changed/.test(
      unreachable[0],
    ),
    `the notice says the service is not reachable (${JSON.stringify(unreachable[0])})`,
  );
  await rowIs("Off");
  check(shim.subscribed.length === subscribedBefore, "nothing was subscribed");

  step(
    "failure: another principal holds this browser's endpoint (409), recovered",
  );
  const other = await stack.principal();
  const theirs = stack.standIn.mint();
  assert.equal((await stack.register(other.bearer, theirs)).status, 201);
  shim.queue.push(theirs);
  await turnOn().click();
  await rowIs("On");
  const mine = await stack.live(principal.id);
  check(
    mine.length === 1,
    `this principal holds one subscription (${mine.length})`,
  );
  check(
    mine[0]?.endpoint !== theirs.endpoint,
    "it is a fresh subscription, not the one the other principal holds",
  );
  check(
    (await stack.live(other.id)).some(
      (sub) => sub.endpoint === theirs.endpoint,
    ),
    "the other principal's record is untouched",
  );
  check(
    shim.unsubscribed.some((sub) => sub.endpoint === theirs.endpoint),
    "the browser let go of the endpoint it could not enrol",
  );
  check((await pushNotices()).length === 0, "a recovered 409 leaves no notice");
  await turnOff().click();
  await rowIs("Off");

  step(
    `failure: the principal is at its limit of ${LIMIT} subscriptions (409)`,
  );
  for (let i = 0; i < LIMIT; i += 1) {
    assert.equal(
      (await stack.register(principal.bearer, stack.standIn.mint())).status,
      201,
    );
  }
  const unsubscribedBefore = shim.unsubscribed.length;
  const subscribedAtLimit = shim.subscribed.length;
  await turnOn().click();
  const limited = await until(
    pushNotices,
    (found) => found.length === 1,
    "a notice that the server refused (409)",
    10_000,
  );
  check(
    /refused that \(409\)/.test(limited[0]),
    `the notice names the refusal (${JSON.stringify(limited[0])})`,
  );
  await rowIs("Off");
  check(
    (await stack.live(principal.id)).length === LIMIT,
    "the server's records are unchanged",
  );
  check(
    shim.subscribed.length === subscribedAtLimit + 1 &&
      shim.unsubscribed.length === unsubscribedBefore + 1,
    "one subscription was made and taken back: a full account is not retried as a 409 takeover",
  );
  check(
    (await page.evaluate(() =>
      navigator.serviceWorker.ready.then((r) =>
        r.pushManager.getSubscription(),
      ),
    )) === null,
    "the browser holds no half-enrolled subscription",
  );

  step(
    "failure: a subscription another tab made, at the limit (409): not left On over nothing",
  );
  // The row says Off; then another tab's subscribe leaves this browser holding
  // one the Identity API does not list, and the principal is still full.
  shim.held = stack.standIn.mint();
  shim.held.appKey = stack.vapid.publicKey;
  const unsubscribedBeforeHeld = shim.unsubscribed.length;
  await turnOn().click();
  await until(
    pushNotices,
    (found) => found.length === 1,
    "a notice that the server refused (409)",
    10_000,
  );
  await rowIs("Off");
  check(
    shim.held === null &&
      shim.unsubscribed.length === unsubscribedBeforeHeld + 1,
    "the held subscription the server cannot record was let go",
  );
  check(
    (await stack.live(principal.id)).length === LIMIT,
    "the server's records are unchanged",
  );

  check(pageErrors.length === 0, `no page errors (${pageErrors.join(" | ")})`);
  await context.close();

  step("failure: an operator policy does not name the Identity API's origin");
  await policyWalk({
    browser,
    stack,
    scope,
    check,
    serve: (config) => {
      served = config;
    },
  });
} catch (error) {
  console.error(error);
  exit = 1;
} finally {
  await browser.close();
  await stack.close();
}
process.exit(finish(exit === 1));
