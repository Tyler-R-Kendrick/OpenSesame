/**
 * Steps for a control only one of the two builds has, or one whose name many
 * panels share. Each is a no-op when its target is absent, which is a
 * legitimate difference between a base build and the branch, never a miss.
 */

export function scopedSteps({ press }) {
  return {
    /** Press a named button inside one region ("Add" is on every Security row). */
    async pressIn(page, [scope, name]) {
      const target = page
        .locator(scope)
        .getByRole("button", { name, exact: true })
        .first();
      if ((await target.count()) && (await target.isEnabled())) {
        await press(target);
        await page.waitForTimeout(1000);
      }
    },
    /**
     * Open a native disclosure whose summary reads like `pattern`, when this
     * build has one — the options a form keeps behind a line of what it will
     * make. A base build that draws them open is a legitimate difference.
     */
    async openDisclosureOptional(page, pattern) {
      const summary = page
        .locator("details:not([open]) > summary")
        .filter({ hasText: new RegExp(pattern, "i") })
        .first();
      if (!(await summary.count())) return;
      await summary.click();
      await page.waitForTimeout(400);
    },
    /** Set a named checkbox through its real control; a missing control fails. */
    async checked(page, { label, value }) {
      await page
        .getByRole("checkbox", { name: label, exact: true })
        .first()
        .setChecked(value);
      await page.waitForTimeout(300);
    },
    /**
     * Type into a field found by label or selector, when this build has it.
     * A native `<select>` is the same difference as an absent field: the
     * base's folder and type cannot be typed into.
     */
    async fillOptional(page, { label, selector, text }) {
      const field = selector
        ? page.locator(selector).first()
        : page.getByLabel(label, { exact: true }).first();
      if (!(await field.count())) return;
      if ((await field.evaluate((node) => node.tagName)) === "SELECT") return;
      await field.fill(text);
      await page.waitForTimeout(300);
    },
  };
}
