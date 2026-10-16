/**
 * Settings and Activity are session roots. The vault rail does not list
 * them; the session prompt's menu (`guest@personal:/`) does, and a `<`
 * key on the rerooted tree returns to the vault.
 */

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
