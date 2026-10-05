/**
 * A vault with something in it, made the way a person makes one.
 *
 * Most tutorials are walked on an empty vault. The ones that point at an item's
 * own controls (favorite, edit, copy, trash, share) or at a filter a vault
 * grows once it holds an account are offered only where a vault holds an item, and
 * their steps point at nothing without one. So the walk makes a second pass:
 * it adds an account through the editor, trashes a second, and walks whatever the
 * library now offers that it did not before. Nothing is injected: the items
 * arrive through the same editor and the same Move to trash key a person uses.
 */

/** Adds one account through the editor and lands on its pane. */
async function addAccount(page, base, { name, username, password }) {
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}vault/new/account`);
  await page.getByLabel("Name", { exact: true }).first().fill(name);
  await page.getByLabel("Username / ID", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page
    .getByRole("heading", { level: 1, name })
    .waitFor({ timeout: 15000 });
}

/**
 * One live account and one account in the trash, so item tours have a pane to
 * open and the trash tour has a row to point its keys at.
 */
export async function seedVault(page, base) {
  await addAccount(page, base, {
    name: "Tutorial login",
    username: "walker",
    password: "correct-horse-battery-staple-9",
  });
  await addAccount(page, base, {
    name: "Tutorial trash",
    username: "walker",
    password: "another-long-password-1234",
  });
  await page.getByRole("button", { name: "Move to trash" }).click();
  await page
    .waitForFunction(
      () => !document.querySelector('button[aria-label="Move to trash"]'),
      undefined,
      { timeout: 10000 },
    )
    .catch(() => {});
}
