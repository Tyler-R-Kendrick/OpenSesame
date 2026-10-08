/**
 * A vault with something in it, made the way a person makes one.
 *
 * Most tutorials are walked on an empty vault. The ones that point at an item's
 * own controls (favorite, edit, copy, trash, share) or at a filter a vault
 * grows once it holds an account are offered only where a vault holds an item, and
 * their steps point at nothing without one. So the walk makes a second pass:
 * it adds an item through the editor, trashes a second, and walks whatever the
 * library now offers that it did not before. Nothing is injected: the items
 * arrive through the same editor and the same Move to trash key a person uses.
 *
 * A full build creates an account. A minimal build cannot: account is a pack
 * it does not install, and the only item the seed can make is a secret (ADR
 * 0153, ADR 0165). `TUTORIALS_ENABLE=installed` is that walk — the build's
 * approvals are left alone. Any other walk reads the new-item type picker,
 * and uses a secret when account is not listed there.
 */

/** Opens an in-app path the way the router hears the back button. */
async function openPath(page, path) {
  await page.evaluate((next) => {
    window.history.pushState({}, "", next);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/**
 * Whether this installation lists account on the new-item type picker.
 * The picker is the bare `/vault/new` editor; a named route shows one type
 * and, when that type is not installed, no picker at all.
 */
async function offersAccount(page, base) {
  await openPath(page, `${base}vault/new`);
  await page
    .getByLabel("Name", { exact: true })
    .first()
    .waitFor({ timeout: 15000 });
  const type = page.getByLabel("Type", { exact: true });
  if ((await type.count()) === 0) return false;
  const values = await type
    .first()
    .locator("option")
    .evaluateAll((options) => options.map((option) => option.value));
  return values.includes("account");
}

/**
 * Account where the build can create one, secret where it cannot.
 * `TUTORIALS_ENABLE=installed` is the minimal profile: it does not turn
 * item-type packs on, so the picker is not consulted.
 */
async function seedKind(page, base) {
  if (process.env.TUTORIALS_ENABLE === "installed") return "secret";
  return (await offersAccount(page, base)) ? "account" : "secret";
}

/** Adds one item through the editor and lands on its pane. */
async function addItem(page, base, kind, fields) {
  await openPath(page, `${base}vault/new/${kind}`);
  await page.getByLabel("Name", { exact: true }).first().fill(fields.name);
  if (kind === "account") {
    await page
      .getByLabel("Username / ID", { exact: true })
      .fill(fields.username);
    await page.getByLabel("Password", { exact: true }).fill(fields.password);
  } else {
    await page.getByLabel("Secret value", { exact: true }).fill(fields.value);
  }
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page
    .getByRole("heading", { level: 1, name: fields.name })
    .waitFor({ timeout: 15000 });
}

/**
 * One live item and one item in the trash, so item tours have a pane to
 * open and the trash tour has a row to point its keys at. The live item
 * holds a value, so Share once is drawn for the share tour.
 */
export async function seedVault(page, base) {
  const kind = await seedKind(page, base);
  await addItem(page, base, kind, {
    name: "Tutorial login",
    username: "walker",
    password: "correct-horse-battery-staple-9",
    value: "correct-horse-battery-staple-9",
  });
  await addItem(page, base, kind, {
    name: "Tutorial trash",
    username: "walker",
    password: "another-long-password-1234",
    value: "another-long-password-1234",
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
