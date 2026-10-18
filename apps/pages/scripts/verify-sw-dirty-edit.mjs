// A service-worker release must not wipe an edit in progress (P8-6 / F7).
//
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium pnpm --filter @opensesame/pages verify:sw-dirty-edit
//
// The first load is born controlled before the door is touched: that claim
// reloads once, by design, because the page does not yet know its release.
// Then a guest opens a new item, the built sw.js shell revision changes, and
// the page says the update is waiting instead of reloading. Leaving the edit
// lets the reload land. Offline is a status mark, not a statusline glyph.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { doorGuest } from "./lib/front-door.mjs";
import { waitOpen } from "./lib/pages-journey.mjs";
import {
  serve as serveDist,
  trackControlledBirth,
  until,
  untilBornControlled,
} from "./lib/push-worker-harness.mjs";
import { bumpShellRevision } from "./lib/sw-revision.mjs";

const dist = path.resolve(import.meta.dirname, "../dist");
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const out = path.resolve(
  import.meta.dirname,
  "../../../artifacts/sw-dirty-edit",
);
const UPDATE_READY = "Update ready — Save, then reload";

if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error(`no build at ${dist} — run the pages build first`);
  process.exit(2);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/** @type {string | null} */
let swOverride = null;
const server = await serveDist(dist, base, null, {
  serviceWorker: (body) => swOverride ?? body,
});
const origin = `http://127.0.0.1:${server.address().port}`;
const scope = `${origin}${base}`;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  headless: true,
});

const failures = [];
const check = (condition, what) => {
  console.log(condition ? "PASS" : "FAIL", what);
  if (!condition) failures.push(what);
};

let exit = 0;
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "allow",
  });
  await trackControlledBirth(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    failures.push(`page error: ${error?.message ?? error}`);
  });
  const timeOrigin = () => page.evaluate(() => performance.timeOrigin);

  await page.goto(scope, { waitUntil: "domcontentloaded" });
  await untilBornControlled(page);
  await doorGuest(page).click();
  await waitOpen(page);

  await context.setOffline(true);
  const offline = page
    .getByRole("img", { name: "Offline" })
    .locator("visible=true");
  await offline.waitFor({ timeout: 10_000 });
  check(await offline.count(), "offline is a visible status mark");
  await context.setOffline(false);
  await offline.waitFor({ state: "hidden", timeout: 10_000 });

  await page.getByRole("link", { name: "New item", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Dirty draft");
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(undefined)),
        );
      }),
  );

  const built = fs.readFileSync(path.join(dist, "sw.js"));
  const bumped = bumpShellRevision(built);
  assert.notEqual(bumped.to, bumped.from);
  swOverride = bumped.source;
  const originWhileEditing = await timeOrigin();

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error("no service worker registration");
    await registration.update();
  });

  const ready = page
    .getByRole("img", { name: UPDATE_READY })
    .locator("visible=true");
  await ready.waitFor({ timeout: 30_000 });
  check(
    (await timeOrigin()) === originWhileEditing,
    "a dirty edit holds the release reload",
  );

  await page
    .getByRole("link", { name: "Cancel", exact: true })
    .locator("visible=true")
    .click();
  await until(
    timeOrigin,
    (next) => next !== originWhileEditing,
    "leaving the edit reloads for the waiting release",
    20_000,
  );
  check(true, "leaving the edit reloads for the waiting release");
} catch (error) {
  exit = 1;
  console.error(error);
  failures.push(error instanceof Error ? error.message : String(error));
  const pages = browser.contexts().flatMap((context) => context.pages());
  const shot = pages[0];
  if (shot) {
    await shot
      .screenshot({ path: path.join(out, "failure.png"), fullPage: true })
      .catch(() => undefined);
  }
} finally {
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(
      { ok: failures.length === 0 && exit === 0, failures },
      null,
      2,
    ),
  );
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  exit = 1;
}
process.exit(exit);
