/**
 * The items the browser-session walks share and withhold, and the accessible
 * names the app derives from them (ADR 0153: a secret item has one concealed
 * field, "Value"). Positive and negative assertions both read these, so a
 * label that drifts fails the positive step instead of letting an absence
 * check pass vacuously.
 */
import { expect } from "@playwright/test";

export const SHARED_ITEM = { name: "GitHub", field: "Value" };
export const PRIVATE_ITEM = { name: "Payroll", field: "Value" };

/** The field's label as the catalog and the edit sheet name it. */
export const fieldLabel = (item) => `${item.name} ${item.field}`;
export const revealName = (item) => `Reveal ${fieldLabel(item)}`;
export const editName = (item) => `Edit ${fieldLabel(item)}`;

/** The joiner's Reveal control for a shared field. */
export const revealButton = (page, item) =>
  page.getByRole("button", { name: revealName(item) });

/**
 * True when no control on the page names the item at all: its reveal, its
 * edit, or anything else carrying its name. The name-only match keeps this
 * honest if the "Reveal <item> <field>" format changes again.
 */
export async function itemAbsent(page, item) {
  const named = await page
    .getByRole("button", { name: new RegExp(item.name) })
    .count();
  const reveal = await revealButton(page, item).count();
  const edit = await page.getByRole("button", { name: editName(item) }).count();
  return named + reveal + edit === 0;
}

/**
 * The joiner is in the session and its catalog has rendered the shared item:
 * waits on the joined state first, so a peer that connected but never
 * delivered the catalog fails here, with this message, not as a click timeout.
 */
export async function joinerSeesCatalog(page, item = SHARED_ITEM) {
  await page
    .getByRole("img", { name: "Joined Team" })
    .waitFor({ timeout: 45_000 })
    .catch((error) => {
      throw new Error(
        `joiner never reached "Joined Team" after Connect: ${error instanceof Error ? error.message : error}`,
      );
    });
  await expect(
    revealButton(page, item),
    `joiner joined but the catalog never showed "${revealName(item)}"`,
  ).toBeVisible({ timeout: 45_000 });
}
