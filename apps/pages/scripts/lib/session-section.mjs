/**
 * Settings and Activity are session roots. The vault rail does not list
 * them; the session prompt's menu (`guest@personal:/`) does, and a `<`
 * key on the rerooted tree returns to the vault.
 */

/** A vault switcher left open covers the session tree on desktop. */
async function dismissVaultSwitcher(page) {
  const menu = page.locator(".project-switcher__menu");
  if (!(await menu.isVisible().catch(() => false))) return;
  const backdrop = page.locator(".project-switcher__backdrop");
  if (await backdrop.isVisible().catch(() => false)) {
    // The backdrop can leave with the menu between seeing it and pressing
    // it. That press timing out is not a failure to dismiss: use Escape.
    try {
      await backdrop.click({ position: { x: 4, y: 4 }, timeout: 5000 });
    } catch {
      await page.keyboard.press("Escape");
    }
  } else {
    await page.keyboard.press("Escape");
  }
  await menu.waitFor({ state: "hidden", timeout: 5000 });
}

/** The shell paints the prompt twice. One of the two is display:none. */
export async function openSessionMenu(page) {
  await page
    .locator(".rail__prompt")
    .filter({ visible: true })
    .click({ button: "right" });
}

export async function openSessionSection(page, name) {
  const sections = page.getByRole("button", { name: "Sections", exact: true });
  if (await sections.isVisible().catch(() => false)) {
    const drawer = page.getByRole("dialog", { name: "Sections", exact: true });
    if (!(await drawer.isVisible().catch(() => false))) await sections.click();
    await drawer.getByRole("link", { name, exact: true }).click();
    await drawer.waitFor({ state: "hidden" });
    return;
  }
  await dismissVaultSwitcher(page);
  const rooted = page.getByRole("treeitem", { name, exact: true });
  if (
    (await rooted.count()) > 0 &&
    (await rooted
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    await rooted.first().click();
    return;
  }
  await openSessionMenu(page);
  await page.getByRole("menuitem", { name, exact: true }).click();
}
