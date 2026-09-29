/** The joiner save a three-process edit session walks, and what the owner sees. */
import { expect } from "@playwright/test";

/** Replace one shared field from the joiner's catalog. */
export async function joinerSaves(page, { label, value }) {
  await page.getByRole("button", { name: `Edit ${label}` }).click();
  await page.getByLabel(`New ${label}`).fill(value);
  await page.getByRole("button", { name: `Save ${label}` }).click();
  await expect(page.getByText(value, { exact: true })).toBeVisible({
    timeout: 45_000,
  });
}

/**
 * The owner's log records the save, then the open vault shows the new secret.
 * `previous` must no longer be on that item.
 */
export async function ownerSeesSave(page, { name, value, previous }) {
  await expect(
    page.getByRole("img", { name: /Ada · edit · GitHub password/ }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole("treeitem", { name: "Vault", exact: true }).click();
  await page.getByRole("treeitem", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "Reveal password" }).click();
  await expect(page.getByText(value, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  expect(await page.getByText(previous, { exact: true }).count()).toBe(0);
}
