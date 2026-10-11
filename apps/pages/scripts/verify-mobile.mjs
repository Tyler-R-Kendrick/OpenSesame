/**
 * The touch journey (DESIGN.md § Touch).
 *
 * Drives the built deployment in real touch contexts — a coarse pointer, a
 * touch-capable context, a device pixel ratio of 3 — and audits every stop
 * against `lib/mobile-contract.mjs`. It walks the roads a person on a phone
 * actually takes: the front door, guest entry, every section behind the
 * sections drawer, the overflow key's own sheets, the item editor, and a
 * locked reload. Then it walks a tablet, where a finger meets the *wide*
 * arrangement — the one place the phone stylesheet and the desktop one can
 * contradict each other with every other gate still green.
 *
 * Run it against a fresh build:
 *   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
 *   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
 *     pnpm --filter @opensesame/pages verify:mobile
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contextMenuTouchContract } from "./lib/context-menu-touch-contract.mjs";
import { doorGuest } from "./lib/front-door.mjs";
import { auditSettings } from "./lib/layout-contract.mjs";
import { chooseCapabilitiesHere } from "./lib/mobile-capabilities.mjs";
import { AUDIT, phoneContext, recordStop } from "./lib/mobile-contract.mjs";
import { doorRoads, helpKey, setupCeremony } from "./lib/mobile-gates.mjs";
import { auditGestures } from "./lib/mobile-gestures.mjs";
import { protectorUnlockStops } from "./lib/mobile-protector-unlock.mjs";
import { sizesToWalk } from "./lib/mobile-sizes.mjs";
import { trustedContactsStops } from "./lib/mobile-trusted-contacts.mjs";
import { phonePolish } from "./lib/phone-polish.mjs";
import {
  backOutStops,
  openVaultList,
  treeActions,
  treeWalks,
} from "./lib/phone-vault.mjs";
import { checkSafeAreas } from "./lib/safe-area-contract.mjs";
import { settingsFileStops } from "./lib/settings-file-contract.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { touchCopyStop } from "./lib/touch-copy-contract.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const out = "/tmp/opensesame-mobile-verification";
const harness = createHarness({ dist, origin, base, out });
fs.mkdirSync(out, { recursive: true });

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
  await touchCopyStop(page, label, harness);
  await harness.snap(page, label, { fullPage: false });
  const chrome = result.chrome.statusline
    ? ` footer=${result.chrome.statusline.h}px`
    : "";
  console.log(`${count === 0 ? "PASS" : `FAIL(${count})`} ${label}${chrome}`);
  return result;
}

/** Reach a section the way a thumb does: the sections key, then its row. */
async function openTab(page, label) {
  const key = page.getByRole("button", { name: "Sections" }).first();
  if ((await key.count()) === 0) return false;
  await key.tap();
  await page.waitForTimeout(450);
  const row = page.locator(".drawer__row", { hasText: label }).first();
  if ((await row.count()) === 0) {
    await page.keyboard.press("Escape");
    return false;
  }
  await row.tap();
  await page.waitForTimeout(500);
  return true;
}

/** Open a chrome key by its accessible name, audit the sheet, close it. */
async function openChromeKey(page, pattern, label) {
  const key = page.getByRole("button", { name: pattern }).first();
  if ((await key.count()) === 0) {
    harness.check(false, `${label}: chrome key is not on screen`);
    return;
  }
  await key.tap();
  await page.waitForTimeout(650);
  await audit(page, label);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
}

/**
 * Notifications, help, and the connection rows are named rows inside the
 * overflow the top bar carries. A phone reaches one with two presses.
 */
async function openOverflowRow(page, pattern, label) {
  const more = page.getByRole("button", { name: /^More —/ }).first();
  if ((await more.count()) === 0) {
    harness.check(false, `${label}: the overflow key is not on screen`);
    return;
  }
  await more.tap();
  await page.waitForTimeout(650);
  const row = page.getByRole("button", { name: pattern }).first();
  if ((await row.count()) === 0) {
    harness.check(false, `${label}: no such row in the overflow`);
    await page.keyboard.press("Escape");
    return;
  }
  await row.tap();
  await page.waitForTimeout(650);
  await audit(page, label);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
}

/** The front door: its two roads, and the guest road in the corner (ADR 0150 §1). */
async function frontDoor(page, stop) {
  await helpKey(page, stop("front-door"), harness);
  await audit(page, stop("front-door"));
  await doorRoads(page, stop, harness);
  // The other road off the front door, and the one a person takes on a phone
  // when they are standing up a deployment.
  const setup = page.getByRole("button", { name: "Set up your own" }).first();
  if (await setup.count()) {
    await setup.tap();
    await page.waitForTimeout(900);
    await audit(page, stop("setup"));
    await setupCeremony(page, stop, { audit, harness });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
  }
}

/** Every section behind the sections drawer, and the tab the Access strip hides. */
async function sections(page, stop) {
  for (const [label, name] of [
    ["connections", "Connections"],
    ["access", "Access"],
    ["identity", "Identity"],
    ["settings", "Settings"],
  ]) {
    if (await openTab(page, name)) await audit(page, stop(label));
  }
  // Settings is the last stop: a finger has no key to press, so the keymap
  // it is given is the Gestures tab (ADR 0170), made with real touches.
  await auditGestures(page, harness, stop, audit);
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
  await treeActions(page, stop, { harness, audit });
  await openVaultList(page);
  await phonePolish.searchKeysBare(page, stop, { harness });
  const create = page
    .getByRole("link", { name: "New item", exact: true })
    .first();
  if ((await create.count()) === 0) {
    harness.check(false, `${stop("list")}: the list has no New item key`);
    return;
  }
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
  await backOutStops(page, stop, { harness, audit });
  await treeWalks(page, stop, { harness });
}

async function walk(browser, phone) {
  const { page, context } = await harness.newPage(browser, {
    device: phoneContext(phone),
  });
  const stop = (name) => `${phone.name}-${name}`;
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  await frontDoor(page, stop);
  await doorGuest(page).tap();
  await page.waitForTimeout(1100);
  await audit(page, stop("vault"));
  await phonePolish.topbarPromptFits(page, stop, { harness });

  await sections(page, stop);
  await settingsFileStops({ page, harness, audit, stop, base });

  // The overflow the top bar carries holds what the statusline would: help,
  // notifications and the connector glyphs. Those belong to capabilities,
  // and a device that has chosen none has no overflow key at all
  // (ADR 0130) — so this installation chooses them, the way a person does,
  // before the walk measures what they draw.
  await chooseCapabilitiesHere(page, ["Guided help", "Push notifications"], {
    harness,
    openTab,
  });
  await audit(page, stop("chosen"));
  await phonePolish.switchesAligned(page, stop, { harness });

  await openTab(page, "Vault");
  await openChromeKey(page, /^More —/, stop("more"));
  await openOverflowRow(page, /^Notifications/, stop("more-notifications"));
  await openOverflowRow(page, /^Identity/, stop("more-identity"));
  await openOverflowRow(page, /^Help$/, stop("more-support"));

  await vaultItem(page, stop);
  await contextMenuTouchContract(page, stop, { harness, openTab, audit });
  await phonePolish.passwordKeysOneLine(page, stop, { harness, base });

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

/** The unlock screen of a vault with an enrolled recovery key (ADR 0152). */
async function protectorUnlock(browser, phone) {
  const { page, context } = await harness.newPage(browser, {
    device: phoneContext(phone),
  });
  await protectorUnlockStops(page, {
    harness,
    audit,
    openTab,
    stop: (name) => `${phone.name}-${name}`,
    origin,
    base,
  });
  await context.close();
}

/** Settings › Trusted contacts: the tab, its five sheets and a refused paste. */
async function trustedContacts(browser, phone) {
  const { page, context } = await harness.newPage(browser, {
    device: phoneContext(phone),
  });
  await trustedContactsStops(page, {
    harness,
    audit,
    openTab,
    stop: (name) => `${phone.name}-${name}`,
    origin,
    base,
  });
  await context.close();
}

/**
 * A finger above 900px: the arrangement the phone roads never reach.
 *
 * Here the top bar is gone by width and the status strip is the whole of the
 * chrome — Support, CommandBar, and the bell. Assert the strip is drawn with
 * those seats on screen and named, and that they are keys a finger can hit.
 */
async function tablet(browser, size) {
  const { page, context } = await harness.newPage(browser, {
    device: phoneContext(size),
  });
  const stop = (name) => `${size.name}-${name}`;
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await doorGuest(page).tap();
  await page.waitForTimeout(1100);
  // The strip's Support key is guided help's, so this installation chooses
  // it before the walk asks whether the key is reachable (ADR 0130).
  await chooseCapabilitiesHere(page, ["Guided help"], { harness, openTab });
  await page.locator(".railtree__row", { hasText: "vault/" }).first().tap();
  await page.waitForTimeout(900);
  // Name the stop before any check runs, or each failure is filed under the
  // stop before it and the log points at the wrong screen.
  harness.setStep(stop("chrome"));
  const chromeCounts = await page.evaluate(() => {
    const visible = (selector) =>
      [...document.querySelectorAll(selector)].filter(
        (el) => el.getClientRects().length > 0,
      );
    return {
      strip: visible("footer.statusline").length,
      keys: visible("footer.statusline button").length,
      command: visible(".statusline__command").length,
      topbar: visible(".topbar").length,
      overflow: visible(".topbar__more").length,
      rail: visible(".rail").length,
    };
  });
  harness.check(
    chromeCounts.strip === 1 &&
      chromeCounts.command === 1 &&
      chromeCounts.keys >= 3,
    `${stop("chrome")}: the status strip with CommandBar is on screen (saw ${chromeCounts.keys} keys in ${chromeCounts.strip} strip)`,
  );
  harness.check(
    chromeCounts.topbar === 0 && chromeCounts.overflow === 0,
    `${stop("chrome")}: the phone's top bar stays off above 900px, so the strip is not doubled`,
  );
  harness.check(
    chromeCounts.rail === 1,
    `${stop("chrome")}: the rail is drawn`,
  );
  // Everything the strip holds has to be reachable by name, not merely
  // painted: support, the command, and notifications.
  for (const name of [/^Support$/, /^Notifications/]) {
    harness.check(
      (await page.getByRole("button", { name }).count()) > 0,
      `${stop("chrome")}: ${name.source} is reachable`,
    );
  }
  await audit(page, stop("vault"));
  await auditSettings(page, (label) => audit(page, label), stop);
  await settingsFileStops({ page, harness, audit, stop, base });
  await context.close();
}

let walked;
try {
  walked = sizesToWalk(process.env.MOBILE_SIZES);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
checkSafeAreas({ dist, harness });
const browser = await harness.launch();
try {
  for (const phone of walked.phones) {
    await walk(browser, phone);
    await protectorUnlock(browser, phone);
    await trustedContacts(browser, phone);
  }
  for (const size of walked.tablets) await tablet(browser, size);
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
  `\nPASS: the touch contract holds at ${[...walked.phones, ...walked.tablets]
    .map((size) => size.width)
    .join(", ")}px.`,
);
