/**
 * Settings and Activity are session roots. The vault rail does not list
 * them; the session prompt's menu (`guest@personal:/`) does, and a `<`
 * key on the rerooted tree returns to the vault.
 */

export async function openSessionSection(page, name) {
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
  await page.locator(".rail__prompt").click({ button: "right" });
  await page.getByRole("menuitem", { name, exact: true }).click();
}
