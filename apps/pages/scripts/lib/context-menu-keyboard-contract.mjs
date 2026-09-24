import { expect } from "@playwright/test";

/**
 * The context menu from the keyboard alone, on the rail, which must already
 * hold focus. `Shift+F10` (the platform key) and `Shift+Enter` (for a
 * keyboard with no F10 or Menu key) each open the cursor row's menu with its
 * first entry focused; the menu owns every key while open — a `j` must not
 * move the tree beneath it — and Escape hands focus back to the tree. An
 * entry runs from the keyboard: End, Enter on "Show hidden items" lists
 * `trash/`, and the same again hides it.
 */
export async function contextMenuKeyboardContract(page) {
  const rail = page.locator(".railtree");
  await expect(rail).toBeFocused();
  const menu = page.getByRole("menu");
  for (const key of ["Shift+F10", "Shift+Enter"]) {
    const here = page.url();
    const cursor = await rail.getAttribute("aria-activedescendant");
    await page.keyboard.press(key);
    await expect(menu).toHaveCount(1);
    const entries = menu.locator('[role^="menuitem"]');
    await expect(entries.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(entries.nth(1)).toBeFocused();
    await page.keyboard.press("j");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(rail).toBeFocused();
    await expect(page).toHaveURL(here);
    expect(await rail.getAttribute("aria-activedescendant")).toBe(cursor);
  }
  const trash = page.locator('.railtree__row[href$="?f=trash"]');
  const toggle = menu.getByRole("menuitemcheckbox", {
    name: "Show hidden items",
  });
  for (const shown of [true, false]) {
    await page.keyboard.press("Shift+F10");
    await page.keyboard.press("End");
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(trash).toHaveCount(shown ? 1 : 0);
    await expect(rail).toBeFocused();
  }
  console.log(
    "PASS keyboard-only context menu: Shift+F10, Shift+Enter, entries, Escape",
  );
}
