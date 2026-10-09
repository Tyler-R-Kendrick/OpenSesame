/**
 * J-CREDENTIALS: an account can always take a credential (ADR 0179). With only
 * Accounts switched on, the `+` on Login methods is there and offers every
 * type; choosing one the vault had not switched on switches it on; a credential
 * kept on its own is listed under the `+` and, chosen, is bound to the account
 * in the same save: never a copy of it.
 */
import { expect } from "@playwright/test";
import { openSettingsCategory, sealWithPin } from "./pages-journey.mjs";

async function switchOn(page, name) {
  const control = page.getByRole("switch", { name, exact: true });
  if ((await control.getAttribute("aria-checked")) === "false")
    await control.click();
  await page.waitForFunction((label) => {
    const found = document.querySelector(
      `[role="switch"][aria-label="${label}"]`,
    );
    return (
      found?.getAttribute("aria-checked") === "true" &&
      found?.getAttribute("aria-busy") !== "true"
    );
  }, name);
}

async function go(page, base, route) {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
}

async function save(page, name) {
  const saveItem = page.getByRole("button", { name: "Save item" }).first();
  await saveItem.click();
  await page.waitForURL((url) => /\/vault\/[^/]+$/.test(url.pathname));
  // The address changes before React replaces the editor. A following create
  // must wait for that replacement or it can fill the previous item's name.
  await expect(saveItem).toBeHidden();
  await expect(
    page
      .locator(".detail__heading")
      .getByRole("heading", { name, exact: true }),
  ).toBeVisible();
}

/** Bound, not copied: the spare is Second's method, and First keeps its own. */
async function confirmBound(page, base, check) {
  await go(page, base, "vault?f=all");
  await page
    .getByRole("treeitem", { name: /^Second/ })
    .first()
    .waitFor();
  const rows = await page.getByRole("treeitem").allTextContents();
  const keys = rows.filter((row) => /API key|Spare key/.test(row));
  check(
    keys.length === 0,
    `a bound key is the account's method, not its own row (${keys.length} API key entries)`,
  );
  const unbound = rows.filter((row) => /not bound/.test(row));
  check(unbound.length === 0, "no credential is left on its own");
  await page
    .getByRole("treeitem", { name: /^Second/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Reveal x-api-key value" }).click();
  check(
    (await page.locator("body").innerText()).includes("ak_spare"),
    "Second holds the spare that was bound",
  );
  await page
    .getByRole("treeitem", { name: /^First/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Reveal x-api-key value" }).click();
  const first = await page.locator("body").innerText();
  check(
    first.includes("ak_first") && !first.includes("ak_spare"),
    "First keeps its own key",
  );
}

export async function walkJCredentials({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  await openSettingsCategory(page, "Vaults");
  await switchOn(page, "Account");

  // A new account, with no credential type switched on but Accounts' own.
  await go(page, base, "vault/new/account");
  await page.getByLabel("Name", { exact: true }).first().fill("First");
  const plus = page.getByRole("button", { name: "Add login method" });
  await plus.waitFor({ timeout: 8000 });
  check(true, "the + on Login methods is drawn with only Accounts switched on");
  await plus.click();
  const picker = page.getByRole("group", { name: "Login method type" });
  const types = await picker.getByRole("button").allTextContents();
  check(
    ["Password", "API key", "Token", "OAuth", "Authenticator"].every((type) =>
      types.includes(type),
    ),
    "it offers every credential type, switched on or not",
  );
  await snap(page, "J-CREDENTIALS-picker");
  await page.getByRole("button", { name: "API key", exact: true }).click();
  await page.getByLabel("X-Api-Key value", { exact: true }).fill("ak_first");
  await save(page, "First");
  check(true, "an account saves with an API key of a type it had to switch on");

  // The type it switched on stays on (the vault holds a key now), so a
  // credential of it may be written alone.
  await go(page, base, "vault/new/api-key");
  await page.getByLabel("Name", { exact: true }).first().fill("Spare key");
  await page.getByLabel("X-Api-Key value", { exact: true }).fill("ak_spare");
  await save(page, "Spare key");

  // A second account takes it from under the + and saves it bound, once.
  await go(page, base, "vault/new/account");
  await page.getByLabel("Name", { exact: true }).first().fill("Second");
  await page.getByRole("button", { name: "Add login method" }).click();
  const existing = page.getByRole("group", { name: "Existing credentials" });
  await existing.waitFor({ timeout: 8000 });
  check(
    (await existing.getByRole("button").allTextContents()).includes(
      "Spare key",
    ),
    "a credential kept on its own is listed under the +",
  );
  await snap(page, "J-CREDENTIALS-existing");
  await existing.getByRole("button", { name: "Spare key" }).click();
  check(
    (await page.getByLabel("X-Api-Key value", { exact: true }).inputValue()) ===
      "ak_spare",
    "choosing it brings its value into the account",
  );
  await save(page, "Second");
  await snap(page, "J-CREDENTIALS-bound");
  await confirmBound(page, base, check);
}
