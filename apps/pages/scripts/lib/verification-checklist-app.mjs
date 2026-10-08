/**
 * In-app checklist screens: session roots, settings, support, statusline,
 * a secret's share submenu, danger, and the lock-screen reset sheet.
 */

import { lockVault, openSettingsCategory } from "./pages-journey.mjs";
import { openSessionMenu, openSessionSection } from "./session-section.mjs";
import {
  BASE,
  ORIGIN,
  mark,
  visibleClick,
} from "./verification-checklist-shot.mjs";

async function railLabels(page) {
  return (await page.locator(".railtree__row").allTextContents()).map((text) =>
    text.trim(),
  );
}

function hasLabel(labels, name) {
  return labels.some(
    (label) => label === name || label.startsWith(`${name}\n`),
  );
}

export async function captureSessionRoots(page, shot, record) {
  await openSessionMenu(page);
  await page.getByRole("menu").waitFor({ timeout: 8_000 });
  const menu = await shot("session-menu");
  const settings = await page
    .getByRole("menuitem", { name: "Settings", exact: true })
    .count();
  const activity = await page
    .getByRole("menuitem", { name: "Activity", exact: true })
    .count();
  mark(record, "U10-settings-menu", settings === 1, menu.includes("Settings"));
  mark(record, "U11-activity-menu", activity === 1, menu.includes("Activity"));
  await visibleClick(page, "menuitem", "Settings");
  await page
    .getByRole("heading", { name: "Settings" })
    .waitFor({ timeout: 15_000 });
  await shot("settings");
  const back = page.getByRole("treeitem", { name: "Back to vault" });
  const backed = await back
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (backed) await back.click();
  mark(
    record,
    "U10-settings-back",
    backed,
    backed ? "Back to vault" : "no back",
  );
  await openSessionSection(page, "Activity");
  await shot("activity");
  const backAgain = page.getByRole("treeitem", { name: "Back to vault" });
  if (await backAgain.isVisible().catch(() => false)) await backAgain.click();
}

async function readName(page) {
  return page.getByLabel("Name", { exact: true }).inputValue();
}

/**
 * New secret at the vault root.
 *
 * The generated name is read before the type changes: Minimal's default is
 * Secret, and a profile that installed item types starts on Account. The
 * secret field is what Share needs, so the type is switched after that read.
 */
export async function createSecret(page, shot, record, editorStep) {
  const opened = await visibleClick(page, "link", "New item");
  if (!opened) return false;
  const name = page.getByLabel("Name", { exact: true });
  await name.waitFor({ state: "visible", timeout: 15_000 });
  const generated = await readName(page);
  if (editorStep && record.profile === "minimal-local") {
    mark(record, "S7-secret-name", /^Secret /.test(generated), generated);
  }
  const type = page.getByLabel("Type", { exact: true });
  if ((await type.count()) > 0 && (await type.isVisible().catch(() => false))) {
    await type.selectOption("secret");
  }
  const values = await page.locator("#secret-value").count();
  if (editorStep) {
    mark(record, "S8-single-secret", values === 1, `secret inputs: ${values}`);
    await shot(editorStep);
  }
  await name.fill("./Work/Example");
  await name.press("Tab");
  if ((await readName(page)) !== "Example") await name.fill("Example");
  const value = page.locator("#secret-value");
  if ((await value.count()) === 1) await value.fill("checklist-secret");
  await page.getByRole("button", { name: "Save item" }).click();
  await page
    .locator(".vtree__row", { hasText: "Example" })
    .first()
    .waitFor({ timeout: 15_000 });
  return true;
}

export async function openShare(page, shot, record, step, checkId) {
  const row = page.locator(".vtree__row", { hasText: "Example" }).first();
  await row.click({ button: "right" });
  const share = page.getByRole("menuitem", { name: "Share", exact: true });
  const seen = await share
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!seen) {
    mark(record, checkId, false, "Share menuitem absent");
    await page.keyboard.press("Escape");
    return false;
  }
  await share.click();
  const drop = page.getByRole("menuitem", {
    name: "Temporary drop",
    exact: true,
  });
  const dropSeen = await drop
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  const once = await page
    .getByRole("menuitem", { name: /share once/i })
    .count();
  if (dropSeen) await shot(step);
  mark(record, checkId, dropSeen, dropSeen ? "Share submenu" : "no submenu");
  if (checkId === "S5-share") {
    mark(
      record,
      "S6-not-share-once",
      dropSeen && once === 0,
      dropSeen ? "Temporary drop" : "no submenu",
    );
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  return dropSeen;
}

export async function trashExample(page) {
  const row = page.locator(".vtree__row", { hasText: "Example" }).first();
  if ((await row.count()) === 0) return false;
  await row.click({ button: "right" });
  const trashed = await visibleClick(page, "menuitem", "Trash", 8_000);
  if (!trashed) await page.keyboard.press("Escape");
  return trashed;
}

/** The category click returns before React draws that panel. */
async function showCategory(page, label, selector) {
  await openSettingsCategory(page, label);
  await page.locator(selector).first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
}

function markSecurity(record, labels, text) {
  mark(
    record,
    "U5-formats",
    !hasLabel(labels, "Formats") && !/^Formats$/m.test(text),
  );
  mark(record, "U6-age-keys", !/Age Keys/.test(text));
  mark(
    record,
    "U7-transport",
    !hasLabel(labels, "Transport") && !/^Transport$/m.test(text),
  );
}

/**
 * Duress and Travel sit below the security fold. Each panel is its own shot
 * so the evidence is the heading, not the top of the page.
 */
async function shotDuress(page, shot, record) {
  const duress = page.locator("#duress-profiles");
  const travel = page.locator("#travel");
  const duressOn = await duress
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  const travelOn = duressOn
    ? await travel
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false)
    : false;
  if (duressOn) await shot("settings-duress", duress);
  if (travelOn) await shot("settings-travel", travel);
  mark(
    record,
    "U8-travel",
    duressOn && travelOn,
    duressOn && travelOn ? "Duress and Travel panels" : "duress panel absent",
  );
}

export async function captureSettings(page, shot, record, trashed) {
  await showCategory(page, "Capabilities", "[data-testid=capabilities-panel]");
  const caps = await shot("settings-capabilities");
  mark(
    record,
    "settings-capabilities",
    /Capabilities/.test(caps),
    "capabilities",
  );
  await showCategory(page, "Security", "#vault-key-protection");
  await shot("settings-security");
  await shotDuress(page, shot, record);
  markSecurity(
    record,
    await railLabels(page),
    await page.evaluate(() => document.body.innerText),
  );
  await showCategory(page, "Vaults", "#vaults");
  await shot("settings-vaults");
  const vaults = await page.evaluate(() => document.body.innerText);
  mark(record, "U9-sealed-store", !/Sealed store/.test(vaults));
  await showCategory(page, "Danger", "#settings-trash");
  const danger = await shot("settings-danger");
  const restore = await page.getByRole("button", { name: /Restore / }).count();
  mark(
    record,
    "U14-trash",
    /Trash is empty/.test(danger) || restore > 0,
    trashed ? `trashed; restore buttons ${restore}` : danger.slice(0, 80),
  );
}

export async function captureCommand(page, shot, record) {
  const input = page.locator("#command-bar-input");
  await input.click();
  await input.fill("/");
  const list = page.getByRole("listbox", { name: "Commands" });
  const open = await list
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  const options = open ? await page.getByRole("option").count() : 0;
  if (open) await shot("command-typeahead");
  mark(record, "S2-typeahead", options > 0, `${options} slash options`);
  await page.keyboard.press("Escape");
  await input.fill("");
}

export async function captureSupport(page, shot, record) {
  const opened = await visibleClick(page, "button", "Support", 8_000);
  if (!opened) {
    mark(record, "H6-search", false, "Support button absent");
    return;
  }
  await page
    .getByRole("dialog", { name: "Support" })
    .waitFor({ timeout: 15_000 });
  const text = await shot("help-support");
  const search = await page
    .getByRole("button", { name: "Search", exact: true })
    .count();
  const ask = await page
    .getByRole("button", { name: "Ask", exact: true })
    .count();
  mark(
    record,
    "H6-search",
    search === 1 && ask === 0,
    `Search ${search} Ask ${ask}`,
  );
  mark(record, "U12-no-webmcp", !/WebMCP/.test(text));
  mark(record, "H1-support", !/WebMCP/.test(text) && /Support/.test(text));
  await page
    .getByRole("dialog", { name: "Support" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
}

export async function captureStatusline(page, shot, record) {
  const footer = page.locator("footer.statusline").first();
  await footer.waitFor({ state: "visible", timeout: 8_000 });
  const labels = await footer
    .locator("button")
    .evaluateAll((nodes) =>
      nodes.map(
        (node) => node.getAttribute("aria-label") ?? node.textContent ?? "",
      ),
    );
  await shot("statusline", footer);
  const joined = labels.join(" | ");
  mark(record, "S3-no-identity-icon", !/identity/i.test(joined), joined);
  mark(
    record,
    "S4-no-webcrypto-icon",
    !/webcrypto|web crypto/i.test(joined),
    joined,
  );
}

export async function captureReset(page, shot, record) {
  await lockVault(page);
  const opened = await visibleClick(
    page,
    "button",
    "Reset this browser?",
    8_000,
  );
  if (!opened) {
    mark(record, "U13-reset", false, "reset control absent");
    return;
  }
  await page
    .getByRole("dialog", { name: "Reset this browser" })
    .waitFor({ timeout: 8_000 });
  const text = await shot("reset-device");
  mark(record, "U13-reset", /Reset this browser/.test(text));
  await page
    .getByRole("dialog", { name: "Reset this browser" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
}

/** Front-door Skip, then the share submenu when that guest vault can open it. */
export async function captureGuestShare(page, shot, record) {
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "domcontentloaded" });
  const skip = await visibleClick(
    page,
    "button",
    "Skip sign-in and continue as guest",
    20_000,
  );
  if (!skip) {
    mark(record, "guest-share", false, "front door skip not shown");
    return;
  }
  const inApp = await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 25_000 })
    .then(() => true)
    .catch(() => false);
  if (!inApp) {
    mark(record, "guest-share", false, "guest skip did not open the vault");
    return;
  }
  const created = await createSecret(page, shot, record, null);
  if (!created) {
    mark(record, "guest-share", false, "guest could not create a secret");
    return;
  }
  await openShare(page, shot, record, "share-menu-guest", "guest-share");
}
