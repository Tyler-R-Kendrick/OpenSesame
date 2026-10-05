/**
 * Switches, for the evidence journeys: a person turning something on and
 * waiting for it to finish.
 */
export function switchSteps({ press }) {
  return {
    /**
     * Switch a named switch on and wait out its work: a pack's download and
     * install end when the switch stops being busy. Optional like
     * `pressOptional`: a base build that has no such switch is skipped, not a
     * failure, so the same journey walks both builds.
     */
    async switchOn(page, name) {
      const target = page.getByRole("switch", { name, exact: true }).first();
      if (!(await target.count())) return;
      await press(target);
      await page
        .waitForFunction(
          (label) =>
            document
              .querySelector(`[role="switch"][aria-label="${label}"]`)
              ?.getAttribute("aria-busy") === "false",
          name,
          { timeout: 15000 },
        )
        .catch(() => undefined);
      await page.waitForTimeout(700);
    },
  };
}
