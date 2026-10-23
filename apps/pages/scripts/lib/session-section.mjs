/**
 * Settings and Activity are session roots. The vault rail does not list
 * them; the session prompt's menu (`guest@personal:/`) does, and a `<`
 * key on the rerooted tree returns to the vault.
 */

/** How many times to dismiss before the menu's own wait fails the walk. */
const DISMISS_TRIES = 3;
/** A press or a click that has not closed the list by now is tried again. */
const DISMISS_STEP_MS = 1_000;

function menuHidden(menu, timeout) {
  return menu
    .waitFor({ state: "hidden", timeout })
    .then(() => true)
    .catch(() => false);
}

/**
 * A vault switcher left open covers the session tree on desktop.
 *
 * Escape first, then the backdrop's corner, the way a person dismisses the
 * list. The corner click is what flakes: the node detaches or will not sit
 * still while the list is already leaving, and one click waits out its
 * timeout. A miss is tried again. Still up after that, the wait fails the walk.
 */
export async function dismissVaultSwitcher(page) {
  const menu = page.locator(".project-switcher__menu");
  if (!(await menu.isVisible().catch(() => false))) return;
  for (let attempt = 0; attempt < DISMISS_TRIES; attempt += 1) {
    await page.keyboard.press("Escape");
    if (await menuHidden(menu, DISMISS_STEP_MS)) return;
    await page
      .locator(".project-switcher__backdrop")
      .click({ position: { x: 4, y: 4 }, timeout: DISMISS_STEP_MS })
      .catch(() => {});
    if (await menuHidden(menu, DISMISS_STEP_MS)) return;
  }
  await menu.waitFor({ state: "hidden", timeout: 5000 });
}

/** The prompt separator owns the session menu; an account key owns its own menu. */
export async function openSessionMenu(page) {
  await page
    .locator(".rail__prompt .prompt__dim")
    .filter({ visible: true })
    .first()
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
