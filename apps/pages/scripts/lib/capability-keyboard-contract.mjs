// Choosing capabilities with the keyboard alone (ADR 0130 + the keyboard
// contract in AGENTS.md §5).
//
// The sections this journey walks — Connections, Access, Identity — belong to
// capabilities, so a device that has approved nothing has no `g c`, no rail
// row and no drawer link for them. That is the product requirement, not a
// regression, and the way past it is the way a person goes: Settings ›
// Capabilities, Add, Apply. Doing it here also holds the new surface to the
// same contract as the rest of the app — every step below is a real key
// press, with no click, no injected focus and no synthetic event.

import { expect } from "@playwright/test";
import { ALWAYS_ON_TITLES } from "./always-on.mjs";

/** Open Settings › Capabilities from wherever the walk is, by keyboard. */
async function openCapabilities(page, tabTo) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/settings(?:[/?].*)?$/, { timeout: 10_000 });
  const tab = page.getByRole("link", { name: "Capabilities", exact: true });
  await tabTo(page, tab);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("capabilities-panel")).toBeVisible();
}

/**
 * Add each capability by name, through its row's Add key and the review's
 * Apply. Asserts the absence first: a row that offers Add is one this
 * installation may have and is not running, so a name that is already
 * approved — or that this distribution does not carry — has no key here and
 * the walk would be lying if it passed anyway.
 */
export async function approveByKeyboard(page, tabTo, titles) {
  for (const title of titles) {
    // Always on (ADR 0135): in every plan, with no row to add it from.
    if (ALWAYS_ON_TITLES.has(title)) continue;
    await openCapabilities(page, tabTo);
    // The per-capability rows are under Advanced: open it by keyboard.
    const advanced = page
      .getByTestId("capabilities-advanced")
      .locator("summary");
    if (
      !(await page
        .getByTestId("capabilities-advanced")
        .evaluate((node) => node.open))
    ) {
      await tabTo(page, advanced);
      await page.keyboard.press("Enter");
    }
    const add = page.getByRole("button", { name: `Add ${title}`, exact: true });
    await expect(add).toHaveCount(1);
    await tabTo(page, add);
    await page.keyboard.press("Enter");
    const review = page.getByTestId("capability-review");
    await expect(review).toBeVisible();
    await expect(review).toContainText(title);
    const apply = page.getByTestId("capability-apply");
    await expect(apply).toBeEnabled();
    await tabTo(page, apply);
    await page.keyboard.press("Enter");
    await expect(review).toHaveCount(0, { timeout: 15_000 });
  }
}
