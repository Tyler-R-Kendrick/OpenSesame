/** Shared password-seal and chrome helpers for experience Playwright walks. */

import { ALWAYS_ON_TITLES, openAdvanced } from "./always-on.mjs";
export const PASSWORD = "correct horse battery staple 2026";

export async function waitOpen(page) {
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 20000 });
}

export async function sealWithPassword(page) {
  await page.getByRole("button", { name: "Use without an account" }).click();
  await page.getByRole("tab", { name: "Password" }).click();
  await page.getByLabel("Master password", { exact: true }).fill(PASSWORD);
  await page
    .getByLabel("Confirm master password", { exact: true })
    .fill(PASSWORD);
  await page
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  await page.getByRole("button", { name: "Seal this device" }).click();
  await waitOpen(page);
}

export async function unlockWithPassword(page) {
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
}

export async function lockVault(page) {
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .click();
  await page
    .getByLabel("Password", { exact: true })
    .waitFor({ timeout: 15000 });
}

export async function openSection(page, label) {
  // Section rows for access/identity/wallet/activity are capability
  // contributions and land after the core rows: wait before concluding the
  // row is absent.
  const rail = page.locator(".railtree__row", { hasText: label }).first();
  const appeared = await rail
    .waitFor({ state: "visible", timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) {
    await rail.click();
    return;
  }
  await page
    .getByText(label, { exact: true })
    .locator("visible=true")
    .first()
    .click();
}

/**
 * Choose capabilities the way a person does — Settings › Capabilities, Add,
 * Apply. A device that has approved nothing has no rail row for the sections
 * those capabilities contribute (ADR 0130), so a walk that needs one says
 * which it needs instead of pretending the row is there.
 */
export async function addCapabilities(page, titles) {
  await openSettingsCategory(page, "Capabilities");
  for (const title of titles) {
    // Always on (ADR 0134): in every plan, with no row to add it from.
    if (ALWAYS_ON_TITLES.has(title)) continue;
    await openAdvanced(page);
    const add = page.getByRole("button", { name: `Add ${title}`, exact: true });
    await add.waitFor({ timeout: 15000 });
    await add.click();
    const review = page.getByTestId("capability-review");
    await review.waitFor({ timeout: 10000 });
    await page.getByTestId("capability-apply").click();
    await review.waitFor({ state: "detached", timeout: 15000 });
  }
}

export async function openGeneral(page) {
  // Settings is the heading the section opens on (it has no "Preferences"
  // heading — that name went with an earlier shape of the panel).
  const heading = page.getByRole("heading", { name: "Settings" });
  if (await heading.isVisible().catch(() => false)) return;
  await openSection(page, "settings/");
  await heading.waitFor({ timeout: 15000 });
}

/** Open a Settings category without a full document navigation (keeps the vault open). */
export async function openSettingsCategory(page, label) {
  await openSection(page, "settings/");
  const link = page.getByRole("link", { name: label, exact: true });
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

export async function setTextarea(page, selector, yaml) {
  const source = page.locator(selector);
  await source.waitFor({ timeout: 8000 });
  await source.evaluate((node, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, yaml);
}

export async function runCommand(page, utterance) {
  const input = page.locator("#command-bar-input");
  await input.fill(utterance);
  await page.getByRole("button", { name: "Run command" }).click();
  await page.waitForTimeout(400);
  await page.locator(".command-bar__status").waitFor({ timeout: 8000 });
  return page.locator(".command-bar__status").innerText();
}
