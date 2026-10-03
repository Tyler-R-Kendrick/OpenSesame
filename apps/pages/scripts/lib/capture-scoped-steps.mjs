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
    /** Type into a field found by label or selector, when this build has it. */
    async fillOptional(page, { label, selector, text }) {
      const field = selector
        ? page.locator(selector).first()
        : page.getByLabel(label, { exact: true }).first();
      if (!(await field.count())) return;
      await field.fill(text);
      await page.waitForTimeout(300);
    },
  };
}
