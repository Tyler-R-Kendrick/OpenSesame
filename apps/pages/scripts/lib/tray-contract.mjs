import { expect } from "@playwright/test";

/**
 * A failure's home is the notifications tray, never a box in the page
 * (DESIGN.md § Status is a symbol). Open the bell wherever this screen draws
 * it — the desktop statusline key, the phone's More menu, or the corner bell a
 * screen with no shell gets — read the sentence there, and close it again.
 */
export async function expectInTray(page, text) {
  const bell = page.getByRole("button", { name: /^Notifications — / });
  const more = page.getByRole("button", { name: /^More — / });
  // The corner bell of a screen with no shell appears only once the notice is
  // raised, so wait for whichever road this screen draws before taking it.
  await expect(bell.or(more).filter({ visible: true }).first()).toBeVisible();
  if (await bell.filter({ visible: true }).count()) {
    await bell.filter({ visible: true }).first().click();
  } else {
    await more.click();
    await page
      .getByRole("button", { name: /^Notifications/ })
      .last()
      .click();
  }
  const sheet = page.getByRole("dialog", { name: "Notifications" });
  await expect(sheet).toContainText(text);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeHidden();
}

/**
 * For a journey that must stay keyboard-only: it does not open the sheet, it
 * checks the bell now announces something pending — the statusline key on a
 * desktop, the More menu's attention mark on a phone, which draws no strip. The
 * sentence itself is asserted where the sheet may be opened (`expectInTray`)
 * and in unit tests.
 */
export async function expectTrayRaised(page) {
  const bell = page.getByRole("button", {
    name: /^Notifications — [1-9]\d* pending/,
  });
  const phone = page.locator(".topbar__more.is-attn");
  await expect(bell.or(phone).filter({ visible: true }).first()).toBeVisible();
}

/**
 * The tray's text, read by opening the bell and closing it again. Closing the
 * sheet gives focus back to where it was, which a journey can check afterwards.
 */
export async function readTray(page) {
  const bell = page.getByRole("button", { name: /^Notifications — / }).first();
  await bell.click();
  const sheet = page.getByRole("dialog", { name: "Notifications" });
  const text = await sheet.innerText();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeHidden();
  return text;
}

/** The bell now announces something pending, wherever this screen draws it. */
export async function waitForTray(page, timeout = 20000) {
  await page
    .getByRole("button", { name: /^Notifications — [1-9]\d* pending/ })
    .locator("visible=true")
    .first()
    .waitFor({ timeout });
}

/**
 * Take the refusal out of the tray: open the bell, read the sentence of the
 * error notice, dismiss every notice and close the sheet, so the next attempt
 * raises its own instead of finding this one still there. For a journey that
 * compares one refusal's words with another's.
 */
export async function takeRefusal(page, timeout = 20000) {
  await waitForTray(page, timeout);
  await page
    .getByRole("button", { name: /^Notifications — / })
    .locator("visible=true")
    .first()
    .click();
  const sheet = page.getByRole("dialog", { name: "Notifications" });
  const body = sheet.locator("article.notice-card--err p").first();
  await body.waitFor({ timeout });
  const text = (await body.innerText()).replace(/\s+/g, " ").trim();
  const dismiss = sheet.getByRole("button", { name: "Dismiss" });
  while ((await dismiss.count()) > 0) await dismiss.first().click();
  if (await sheet.isVisible()) {
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
  }
  await expect(sheet).toBeHidden();
  return text;
}

/**
 * Everything the tray holds right now, "" when nothing is pending: the desktop
 * statusline key or the phone's More menu, opened and closed again. For a walk
 * that asks "was this refused, and in what words" without knowing which screen
 * draws the bell.
 */
export async function trayText(page) {
  const bell = page
    .getByRole("button", { name: /^Notifications — [1-9]\d* pending/ })
    .locator("visible=true");
  const phone = page.locator(".topbar__more.is-attn").locator("visible=true");
  if ((await bell.count()) === 0 && (await phone.count()) === 0) return "";
  if (await bell.count()) {
    await bell.first().click();
  } else {
    await phone.first().click();
    await page
      .getByRole("button", { name: /^Notifications/ })
      .last()
      .click();
  }
  const sheet = page.getByRole("dialog", { name: "Notifications" });
  const text = await sheet.innerText();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeHidden();
  return text;
}
