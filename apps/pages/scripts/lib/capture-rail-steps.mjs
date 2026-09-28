/**
 * Rail verbs: follow a row by name, and open a branch that only one of the
 * two builds draws as one (the base may draw it as a plain row); and the
 * clock a rail's timestamps are read from.
 */
export function railSteps() {
  return {
    /** Click a rail row by its exact name, the way a person follows it. */
    async rail(page, name) {
      const row = page.getByRole("treeitem", { name, exact: true }).first();
      if ((await row.count()) === 0)
        throw new Error(
          `capture-evidence rail("${name}"): no rail row matched — refusing a silent miss`,
        );
      await row.click();
      await page.waitForTimeout(1500);
    },
    /** `rail`, for a row only one of the two builds draws ("Load 3 more"). */
    async railOptional(page, name) {
      const row = page.getByRole("treeitem", { name, exact: true }).first();
      if (!(await row.count())) return;
      await row.click();
      await page.waitForTimeout(1500);
    },
    /**
     * Let time pass on the page's clock (a journey with `clock` set), so
     * events a person makes minutes apart are not captured as one burst.
     */
    async elapse(page, seconds) {
      await page.clock.fastForward(seconds * 1000);
      await page.waitForTimeout(300);
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
