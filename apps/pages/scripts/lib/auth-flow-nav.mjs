/**
 * Navigation the authentication walk shares between its journeys: into
 * Settings › Security, and the lock key. `onFailure` lets the walk keep its own
 * record (screenshots, log) when Settings cannot be reached.
 */
import { openSessionSection } from "./session-section.mjs";

export async function openSecurity(page, onFailure) {
  try {
    await openSessionSection(page, "Settings");
  } catch (error) {
    await onFailure?.();
    throw error;
  }
  await page.waitForTimeout(600);
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("link", { name: /^security/i })
    .first()
    .click();
  await page.waitForTimeout(600);
}

export async function lock(page) {
  // Two profile lock buttons exist (phone header, desktop rail); only one is
  // visible at any width.
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .click();
  await page.waitForTimeout(800);
}
