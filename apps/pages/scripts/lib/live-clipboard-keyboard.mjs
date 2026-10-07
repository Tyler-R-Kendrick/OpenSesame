import { expect } from "@playwright/test";

/** Read only after this real keyboard copy reports actual clipboard success. */
export async function copyByKeyboard(page, root, label) {
  await page.keyboard.press("Enter");
  await expect(
    root.getByRole("button", { name: `Copied ${label}`, exact: true }),
  ).toBeVisible();
  return page.evaluate(() => navigator.clipboard.readText());
}
