import { expect } from "@playwright/test";

/**
 * A failure's home is the notifications tray, never a box in the page
 * (DESIGN.md § Status is a symbol). Open the bell wherever this screen draws
 * it — the desktop statusline key, the phone's More menu, or the corner bell a
 * screen with no shell gets — read the sentence there, and close it again.
 */
export async function expectInTray(page, text) {
  const bell = page.getByRole("button", { name: /^Notifications — / });
  if (
    !(await bell
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    const more = page.getByRole("button", { name: /^More — / });
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      await page
        .getByRole("button", { name: /^Notifications/ })
        .last()
        .click();
    }
  } else {
    await bell.first().click();
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
