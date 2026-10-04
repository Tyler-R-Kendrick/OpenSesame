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
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";
import { capabilityOnSwitch, capabilitySwitch } from "./lib/always-on.mjs";
import { doorGuest } from "./lib/front-door.mjs";
import {
  addCapabilities,
  openSettingsCategory,
  waitOpen,
} from "./lib/pages-journey.mjs";

const dist = path.resolve(import.meta.dirname, "../dist");
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const TITLE = "Push notifications";
const REF = "rv_Ab12-Cd34";
const REF_AFTER = "rv_After-0001";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/** `dist/` under `base`, as a static host serves it; a route is index.html. */
function serve() {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const rel = pathname.startsWith(base)
      ? pathname.slice(base.length)
      : pathname.slice(1);
    const file = path.join(dist, rel);
    if (rel && fs.existsSync(file) && fs.statSync(file).isFile()) {
      response.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      return response.end(fs.readFileSync(file));
    }
    if (/\.[a-z0-9]+$/i.test(rel)) {
      response.writeHead(404);
      return response.end("not found");
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(fs.readFileSync(path.join(dist, "index.html")));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

const failures = [];
const check = (condition, what) => {
  console.log(condition ? "PASS" : "FAIL", what);
  if (!condition) failures.push(what);
};

/** The worker script this scope runs, or what is installing over it. */
const scriptsOf = (page) =>
  page.evaluate(
    async (scope) => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const own = registrations.filter((r) => r.scope === scope);
      return {
        registrations: registrations.length,
        active: own[0]?.active?.scriptURL ?? null,
        installing: own[0]?.installing?.scriptURL ?? null,
        waiting: own[0]?.waiting?.scriptURL ?? null,
        controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      };
    },
    `${new URL(page.url()).origin}${base}`,
  );

async function until(read, ok, what, timeout = 25_000) {
  const stop = Date.now() + timeout;
  let last;
  while (Date.now() < stop) {
    try {
      last = await read();
      if (ok(last)) return last;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${what}: ${JSON.stringify(last)}`);
}

const notificationsOf = (page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.getNotifications()).map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      data: n.data,
    }));
  });

const server = await serve();
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

  // A device that has only met the front door holds the core worker.
  await page.goto(scope);
  const core = `${scope}sw.js`;
  await until(
    () => scriptsOf(page),
    (s) => s.active === core && s.controller === core,
    "the core worker should be active and controlling after first load",
  );
  await doorGuest(page).waitFor({ timeout: 20_000 });
  await doorGuest(page).click();
  await waitOpen(page);
  // The first install reloads the page once, by design; count from here.
  await page.waitForTimeout(500);
  const documentBefore = await documentOrigin();
  let state = await scriptsOf(page);
  check(
    state.active === core,
    "before approval the scope runs the core worker",
  );

  // The core worker has no push handler: a push to it shows no doorbell.
  await deliver({ kind: "authorization_request", action: "review", ref: REF });
  await page.waitForTimeout(800);
  check(
    (await notificationsOf(page)).length === 0,
    "the core worker shows nothing for a push (it has no handler)",
  );

  // Approve Push notifications the way a person does.
  await addCapabilities(page, [TITLE]);
  state = await until(
    () => scriptsOf(page),
    (s) =>
      s.active === `${scope}sw-push.js` &&
      s.controller === `${scope}sw-push.js`,
    "approving Push notifications should install and hand the page to sw-push.js",
  );
  check(
    true,
    `approving Push notifications moved the scope to ${state.active}`,
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

  // The doorbell: a decrypted push becomes the notification the contract says.
  await deliver({ kind: "authorization_request", action: "review", ref: REF });
  const shown = await until(
    () => notificationsOf(page),
    (list) => list.some((n) => n.data?.ref === REF),
    "the push worker should show the pushed message",
  );
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
  await deliver({
    kind: "authorization_request",
    action: "review",
    ref: "../x",
    title: "Your password is hunter2",
    authorizationDetails: { secret: "x" },
  });
  // The generic doorbell is the one tagged without a reference.
  const hostile = await until(
    () => notificationsOf(page),
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
    () => scriptsOf(page),
    (s) =>
      s.active === `${scope}sw-push.js` &&
      s.controller === `${scope}sw-push.js`,
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
  const documentAtRevert = await documentOrigin();
  await capabilitySwitch(page, TITLE).click();
  const reviewKey = page.getByTestId("capability-review");
  if ((await reviewKey.count()) > 0) {
    await page
      .getByRole("button", { name: /confirm|apply|remove|continue/i })
      .first()
      .click();
  }
  state = await until(
    () => scriptsOf(page),
    (s) => s.active === core && s.controller === core,
    "removing Push notifications should return the scope to the core worker",
  );
  check(state.registrations === 1, "reverting leaves one registration");
  check(
    (await documentOrigin()) === documentAtRevert,
    "reverting did not reload the page",
  );
  await deliver({
    kind: "authorization_request",
    action: "review",
    ref: REF_AFTER,
  });
  await page.waitForTimeout(1500);
  check(
    (await notificationsOf(page)).every((n) => n.data?.ref !== REF_AFTER),
    "after reverting, the core worker again shows nothing for a push",
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
