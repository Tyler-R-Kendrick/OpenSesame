/**
 * The phone journey (DESIGN.md § Touch).
 *
 * Drives the built deployment on three real phone contexts — a coarse pointer,
 * a touch-capable context, a device pixel ratio of 3 — and audits every stop
 * against `lib/mobile-contract.mjs`. It walks the roads a person on a phone
 * actually takes: the front door, guest entry, every section behind the tab
 * bar, the footer's own sheets, the item editor, and a locked reload.
 *
 * Run it against a fresh build:
 *   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
 *   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
 *     pnpm --filter @opensesame/pages verify:mobile
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIT,
  PHONES,
  phoneContext,
  recordStop,
} from "./lib/mobile-contract.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const out = "/tmp/opensesame-mobile-verification";
const harness = createHarness({ dist, origin, base, out });
fs.mkdirSync(out, { recursive: true });

/**
 * The bottom chrome has to clear the home indicator, and headless Chromium
 * reports every safe-area inset as zero — so the insets are asserted in the
 * stylesheet rather than in the layout. Reading the built CSS keeps the claim
 * honest: it is the shipped file, not the source we hoped got shipped.
 */
function checkSafeAreas() {
  const assets = path.join(dist, "assets");
  const css = fs
    .readdirSync(assets)
    .filter((file) => file.endsWith(".css"))
    .map((file) => fs.readFileSync(path.join(assets, file), "utf8"))
    .join("\n");
  for (const [what, pattern] of [
    [
      "the tab bar clears the home indicator",
      /\.tabbar\{[^}]*safe-area-inset-bottom/,
    ],
    ["the top bar clears the notch", /\.topbar\{[^}]*safe-area-inset-top/],
    ["side gutters clear a landscape notch", /safe-area-inset-left/],
  ]) {
    harness.check(
      pattern.test(css.replace(/\s+/g, "")) || pattern.test(css),
      what,
    );
  }
}

async function audit(page, label) {
  await page.waitForTimeout(350);
  // A string body keeps the audit out of the bundler; Playwright evaluates a
  // string as an expression, so it has to call itself.
  const result = await page.evaluate(`(${AUDIT})()`);
  const count = recordStop(harness, label, result);
  harness.check(
    result.coarse,
    `${label}: measured in a coarse-pointer context`,
  );
  await harness.snap(page, label, { fullPage: false });
  const chrome = result.chrome.statusline
    ? ` footer=${result.chrome.statusline.h}px tabs=${result.chrome.tabbar?.h ?? "-"}px`
    : "";
  console.log(`${count === 0 ? "PASS" : `FAIL(${count})`} ${label}${chrome}`);
  return result;
}

/** Reach a section through the tab bar, the way a thumb does. */
async function openTab(page, label) {
  const link = page.locator(".tabbar__link", { hasText: label }).first();
  if ((await link.count()) === 0) return false;
  await link.tap();
  await page.waitForTimeout(500);
  return true;
}

/** Open a footer key by its accessible name, audit the sheet, close it. */
async function openFooterSheet(page, pattern, label) {
  const key = page.getByRole("button", { name: pattern }).first();
  if ((await key.count()) === 0) {
    harness.check(false, `${label}: footer key is not on the strip`);
    return;
  }
  await key.tap();
  await page.waitForTimeout(650);
  await audit(page, label);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
}

/**
 * A connector ceremony, which on a phone is two presses: the connector glyphs
 * roll up into the overflow key, so Host is a named row inside it rather than
 * a glyph on the strip.
 */
async function openOverflowConnector(page, label) {
  const more = page.getByRole("button", { name: /^More —/ }).first();
  if ((await more.count()) === 0) {
    harness.check(false, `${label}: the overflow key is not on the strip`);
    return;
  }
  await more.tap();
  await page.waitForTimeout(650);
  const host = page.getByRole("button", { name: /^Host/ }).first();
  if ((await host.count()) === 0) {
    harness.check(false, `${label}: Host is not a row in the overflow`);
    await page.keyboard.press("Escape");
    return;
  }
  await host.tap();
  await page.waitForTimeout(650);
  await audit(page, label);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
}

/** The front door and the two roads a person with no account has. */
async function frontDoor(page, stop) {
  await audit(page, stop("front-door"));
  for (const name of [
    "Skip sign-in and continue as guest",
    "Continue as guest",
  ]) {
    const exact = name !== "Skip sign-in and continue as guest";
    harness.check(
      (await page.getByRole("button", { name, exact }).count()) > 0,
      `${stop("front-door")}: "${name}" is offered`,
    );
  }
  // The other road off the front door, and the one a person takes on a phone
  // when they are standing up a deployment.
  const setup = page.getByRole("button", { name: "Set up your own" }).first();
  if (await setup.count()) {
    await setup.tap();
    await page.waitForTimeout(900);
    await audit(page, stop("setup"));
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
  }
}

/** Every section behind the tab bar, and the tab the Access strip hides. */
async function sections(page, stop) {
  for (const [label, name] of [
    ["connections", "Connections"],
    ["access", "Access"],
    ["identity", "Identity"],
    ["settings", "Settings"],
  ]) {
    if (await openTab(page, name)) await audit(page, stop(label));
  }
  // Access keeps five more tabs in a scrolling strip; the far one has to be
  // reachable and has to bring itself into view once it is current.
  if (!(await openTab(page, "Access"))) return;
  const far = page.locator(".access-tab", { hasText: /^Policies/ }).first();
  if ((await far.count()) === 0) {
    harness.check(
      false,
      `${stop("access-policies")}: the Policies tab is missing`,
    );
    return;
  }
  await far.scrollIntoViewIfNeeded();
  await far.tap();
  await page.waitForTimeout(500);
  await audit(page, stop("access-policies"));
}

/**
 * The editor, then the vault with something in it. An empty vault hides every
 * row, every verb and the pane switch the phone layout turns list and detail
 * into, so the walk saves an item and comes back through it.
 */
async function vaultItem(page, stop) {
  const create = page
    .getByRole("link", { name: "New item", exact: true })
    .first();
  if ((await create.count()) === 0) return;
  await create.tap();
  await page.waitForTimeout(800);
  await audit(page, stop("editor"));
  const save = page
    .getByRole("button", { name: "Save item", exact: true })
    .first();
  if ((await save.count()) === 0) return;
  await save.scrollIntoViewIfNeeded();
  await save.tap();
  await page.waitForTimeout(900);
  await audit(page, stop("item"));
  await openTab(page, "Vault");
  await audit(page, stop("list"));
}

async function walk(browser, phone) {
  const { page, context } = await harness.newPage(browser, {
    device: phoneContext(phone),
  });
  const stop = (name) => `${phone.name}-${name}`;
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  await frontDoor(page, stop);
  await page
    .getByRole("button", { name: "Continue as guest", exact: true })
    .tap();
  await page.waitForTimeout(1100);
  await audit(page, stop("vault"));

  await sections(page, stop);

  await openTab(page, "Vault");
  await openFooterSheet(page, /^Notifications/, stop("footer-notifications"));
  await openFooterSheet(page, /^More —/, stop("footer-more"));
  await openOverflowConnector(page, stop("footer-host"));
  await openFooterSheet(page, /support|help/i, stop("footer-support"));

  await vaultItem(page, stop);

  // A locked reload is the screen most phone sessions actually start on.
  await openTab(page, "Vault");
  const lock = page.getByRole("button", { name: "Lock vault" }).first();
  if (await lock.count()) {
    await lock.tap();
    await page.waitForTimeout(900);
    await audit(page, stop("unlock"));
  }

  await context.close();
}

checkSafeAreas();
const browser = await harness.launch();
try {
  for (const phone of PHONES) await walk(browser, phone);
} finally {
  await browser.close();
}

fs.writeFileSync(
  path.join(out, "log.json"),
  JSON.stringify(harness.log, null, 2),
);

if (harness.failures.length > 0) {
  console.error(`\n${harness.failures.length} mobile contract failures:`);
  for (const failure of harness.failures) console.error(`  ${failure}`);
  console.error(`\nScreens and text dumps: ${out}`);
  process.exit(1);
}
console.log(
  `\nPASS: the phone contract holds at ${PHONES.map((p) => p.width).join(", ")}px.`,
);
