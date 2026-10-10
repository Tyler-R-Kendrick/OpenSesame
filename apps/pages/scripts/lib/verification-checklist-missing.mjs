/**
 * The lock-control tour when the control is not on screen.
 */

import { mark, visibleClick } from "./verification-checklist-shot.mjs";

/**
 * Start Lock the vault with the lock control disconnected, then step onto
 * the focus. The tour says the control is not on screen instead of lighting
 * a box that is not there.
 */
export async function captureMissingControl(page, shot, record) {
  const hideLock = () =>
    page.locator("[data-guide-targets~='shell.lock']").evaluateAll((nodes) => {
      for (const node of nodes) {
        node.style.setProperty("display", "none", "important");
      }
      return nodes.length;
    });
  const showLock = () =>
    page.locator("[data-guide-targets~='shell.lock']").evaluateAll((nodes) => {
      for (const node of nodes) node.style.removeProperty("display");
    });
  let recorded = false;
  const note = (ok, detail) => {
    recorded = true;
    mark(record, "H2-missing-control", ok, detail);
  };
  try {
    const opened = await visibleClick(page, "button", "Support", 8_000);
    if (!opened) {
      note(false, "Support button absent");
      return;
    }
    const sheet = page.getByRole("dialog", { name: "Support" });
    await sheet.waitFor({ timeout: 15_000 });
    await sheet.getByRole("tab", { name: "Tutorials", exact: true }).click();
    const row = sheet.locator("[data-tutorial='vault.lock']");
    const seen = await row
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (!seen) {
      note(false, "lock tutorial absent");
      await sheet.getByRole("button", { name: "Close", exact: true }).click();
      return;
    }
    await hideLock();
    await row.click();
    const card = page.locator(".coach__card");
    await card.waitFor({ timeout: 15_000 });
    await hideLock();
    await card.getByRole("button", { name: /^Next/ }).click();
    const cue = card.locator(".coach__cue");
    const noted = await cue
      .getByText("not on screen")
      .waitFor({ timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    const text = await shot("missing-control", card);
    note(
      noted && /not on screen/.test(text),
      noted ? "not on screen" : text.slice(0, 120),
    );
    const exit = page.getByRole("button", { name: "Exit tutorial" });
    if (await exit.isVisible().catch(() => false)) await exit.click();
    await card
      .waitFor({ state: "hidden", timeout: 8_000 })
      .catch(() => undefined);
  } catch (error) {
    if (!recorded) {
      note(false, String(error?.message || error).slice(0, 180));
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  } finally {
    await showLock().catch(() => undefined);
  }
}
