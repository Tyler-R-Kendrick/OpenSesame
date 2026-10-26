/** Shared PIN-seal and chrome helpers for experience Playwright walks. */

import { expect } from "@playwright/test";
import {
  ALWAYS_ON_TITLES,
  awaitCapabilitySections,
  capabilityOffSwitch,
  capabilityOnSwitch,
} from "./always-on.mjs";
import { passTheDoor } from "./front-door.mjs";
import { openSessionMenu, openSessionSection } from "./session-section.mjs";
/**
 * The key every walk seals its vault with. A passkey cannot be made headless
 * and a master password is no longer offered to seal a vault (ADR 0180), so
 * the device PIN is the typed key a journey can use.
 */
export const PIN = "48291037";

export async function waitOpen(page) {
  const deadline = performance.now() + 20000;
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 20000 });
  // Let the ceremony finish on the existing clock. Calling runFor here
  // would install a clock on ordinary pages and reset their wall time.
  // Readiness also requires the ceremony to finish; keep its existing 10s
  // bound within the 20s open budget.
  await page.locator(".unlock").waitFor({
    state: "detached",
    timeout: Math.min(10000, Math.max(1, deadline - performance.now())),
  });
}

/** Sign-in is already up: the no-account road seals a vault on this device. */
export async function sealLocalOnly(page) {
  await page.getByRole("button", { name: "Use without an account" }).click();
  await page.getByRole("tab", { name: "PIN" }).click();
  await page.getByLabel("Device PIN", { exact: true }).fill(PIN);
  await page.getByLabel("Confirm PIN", { exact: true }).fill(PIN);
  await page
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  await page.getByRole("button", { name: "Seal with PIN" }).click();
  await waitOpen(page);
}

/** First-run PIN seal, behind the door (ADR 0150 §1). */
export async function sealWithPin(page) {
  await passTheDoor(page);
  await sealLocalOnly(page);
}

export async function unlockWithPin(page) {
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
}

export async function lockVault(page) {
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .click();
  // A vault sealed here asks for its PIN; a seeded one may still hold a password.
  await page.getByLabel(/^(PIN|Password)$/).waitFor({ timeout: 15000 });
}

const SESSION_ROOTS = {
  "settings/": "Settings",
  "activity/": "Activity",
};

async function clickVaultRow(page, label) {
  const rail = page.locator(".railtree__row", { hasText: label }).first();
  const appeared = await rail
    .waitFor({ state: "visible", timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return false;
  await rail.click();
  return true;
}

export async function openSection(page, label) {
  const session = SESSION_ROOTS[label];
  if (session) {
    await openSessionSection(page, session);
    return;
  }
  // A session root replaces the vault directories. The row comes back
  // after the `<` key. Capability rows can also land a moment late.
  const back = page.getByRole("treeitem", { name: "Back to vault" });
  if (await back.isVisible().catch(() => false)) await back.click();
  if (await clickVaultRow(page, label)) return;
  await page
    .getByText(label, { exact: true })
    .locator("visible=true")
    .first()
    .click();
}

/** Activate a visible switch without dismissing a notice over its pointer target. */
export async function activateCapabilitySwitch(page, key) {
  await key.focus();
  await expect(key).toBeFocused();
  await page.keyboard.press("Space");
}

/**
 * Choose capabilities the way a person does — Settings › Features and the
 * capability's switch, which commits in place. A device that has approved
 * nothing has no rail row for the sections those capabilities contribute
 * (ADR 0130), so a walk that needs one says which it needs instead of
 * pretending the row is there.
 */
export async function addCapabilities(page, titles) {
  await openSettingsCategory(page, "Features");
  for (const title of titles) {
    // Always on (ADR 0135): in every plan, with no row to add it from.
    if (ALWAYS_ON_TITLES.has(title)) continue;
    await awaitCapabilitySections(page);
    const add = capabilityOffSwitch(page, title);
    if ((await add.count()) === 0) {
      await capabilityOnSwitch(page, title).waitFor({ timeout: 15000 });
      continue;
    }
    await add.waitFor({ timeout: 15000 });
    await activateCapabilitySwitch(page, add);
    await page.getByTestId("capability-review").waitFor({
      state: "detached",
      timeout: 15000,
    });
    await capabilityOnSwitch(page, title).waitFor({ timeout: 15000 });
  }
}

export async function openGeneral(page) {
  // A user-category visit can leave the Settings tree rooted in User
  // Settings. General belongs to the vault group, whose heading still exists.
  const heading = page.getByRole("heading", { name: "Vault Settings" });
  if (!(await heading.isVisible().catch(() => false))) {
    await openSettingsCategory(page, "General");
    await heading.waitFor({ timeout: 15000 });
  }
}

/** Open a Settings category without a full document navigation (keeps the vault open). */
export async function openSettingsCategory(page, label) {
  if (label === "Keybindings" || label === "Vaults") {
    await page
      .getByTitle("Switch account", { exact: true })
      .filter({ visible: true })
      .first()
      .click({ button: "right" });
    const account = page.getByRole("menu", { name: "Account", exact: true });
    await account
      .getByRole("menuitem", { name: "User Settings", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "User Settings", exact: true })
      .waitFor();
  } else {
    // Select the real Settings destination, not a remembered User Settings
    // child of the desktop rail. Phone drawer links navigate there directly.
    const sections = page.getByRole("button", {
      name: "Sections",
      exact: true,
    });
    if (await sections.isVisible()) {
      await openSessionSection(page, "Settings");
    } else {
      await openSessionMenu(page);
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
    }
    await page
      .getByRole("heading", { name: "Vault Settings", exact: true })
      .waitFor({ timeout: 15000 });
  }
  // Inside a category the breadcrumb names it too: the sections list is the one.
  const section = page
    .locator(".set__nav")
    .getByRole("link", { name: label, exact: true });
  const link = (await section.count())
    ? section
    : page.getByRole("link", { name: label, exact: true });
  if (await link.count()) {
    await link.click();
  } else {
    await page
      .getByText(label, { exact: true })
      .locator("visible=true")
      .first()
      .click();
  }
}

export async function runCommand(page, utterance) {
  const input = page.locator("#command-bar-input");
  await input.fill(utterance);
  await page.getByRole("button", { name: "Run command" }).click();
  await page.waitForTimeout(400);
  await page.locator(".command-bar__status").waitFor({ timeout: 8000 });
  return page.locator(".command-bar__status").innerText();
}

/**
 * Open a settings directory's `config.yaml` by its path. The rail lists the
 * file only while it shows hidden items; the command bar opens it at any
 * width, which is the road a journey that is not about the rail should take.
 * The file's view is the page: the address names it, and the page is drawn
 * with no text editor.
 */
export async function openConfigFile(page, category) {
  const opened = await runCommand(page, `settings/${category}/config.yaml`);
  if (!/Opened/i.test(opened))
    throw new Error(`config.yaml for ${category} did not open: ${opened}`);
  await page.waitForURL(/[?&]file=config\.yaml/, { timeout: 8000 });
  await page.locator(".set__nav").waitFor({ timeout: 8000 });
  if ((await page.locator(".set-raw").count()) !== 0)
    throw new Error(`config.yaml for ${category} drew a text editor`);
}

/** The directory's own page, by its tab (drops any open file). */
export async function openConfigForm(page, label) {
  await openSettingsCategory(page, label);
}

/**
 * Check or clear the rail's "Show hidden items" the way a person does: the
 * context menu on a rail row. Returns whether it had to change.
 */
export async function setShowHidden(page, on) {
  await page
    .locator(".railtree__row", { hasText: "vault/" })
    .first()
    .click({ button: "right" });
  const toggle = page.getByRole("menuitemcheckbox", {
    name: "Show hidden items",
  });
  await toggle.waitFor({ timeout: 8000 });
  if ((await toggle.getAttribute("aria-checked")) === String(on)) {
    await page.keyboard.press("Escape");
    return false;
  }
  await toggle.click();
  return true;
}
