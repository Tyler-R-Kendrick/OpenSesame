/**
 * Rail verbs: follow a row by name, and open a branch that only one of the
 * two builds draws as one (the base may draw it as a plain row).
 */
export function railSteps() {
  return {
    /** Click a rail row by its exact name, the way a person follows it. */
    async rail(page, name) {
      const row = page.locator(`.railtree__row[aria-label="${name}"]`).first();
      if ((await row.count()) === 0)
        throw new Error(
          `capture-evidence rail("${name}"): no rail row matched — refusing a silent miss`,
        );
      await row.click();
      await page.waitForTimeout(1500);
    },
    /** `expand`, for a branch only one of the two builds draws as one. */
    async expandOptional(page, label) {
      const row = page
        .locator(".railtree__row[aria-expanded]")
        .filter({ hasText: label })
        .first();
      if (!(await row.count())) return;
      if ((await row.getAttribute("aria-expanded")) !== "true") {
        await row.locator(".railtree__caret").click({ force: true });
        await page.waitForTimeout(800);
      }
    },
  };
}
