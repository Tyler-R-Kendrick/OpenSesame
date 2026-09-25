/**
 * Capture verbs that change what a device has switched on — Settings ›
 * Capabilities' own Add, a feature's own switch, then Apply (ADR 0130) —
 * kept beside `capture-evidence.mjs`'s own. `press` is that script's
 * tap-or-click; `openSettings(page, name)` opens a Settings page by name.
 */
export function capabilitySteps({ press, openSettings }) {
  /** Press what proposes a capability change, then Settings' own Apply. */
  async function apply(page, control) {
    await press(control);
    await page.waitForTimeout(400);
    await press(page.getByTestId("capability-apply"));
    await page
      .getByTestId("capability-review")
      .waitFor({ state: "detached", timeout: 20_000 });
    await page.waitForTimeout(600);
  }

  return {
    /**
     * Switch an optional capability on, through Settings › Capabilities' own
     * Add and Apply — Access, Identity and Connections are capabilities, and
     * a guest device has none of them until it chooses (ADR 0130).
     */
    async enable(page, title) {
      await openSettings(page, "Capabilities");
      const add = page.getByRole("button", {
        name: `Add ${title}`,
        exact: true,
      });
      if (await add.count()) await apply(page, add.first());
    },
    /** A whole feature, by its own switch — what a person actually turns on. */
    async feature(page, title) {
      await openSettings(page, "Capabilities");
      const toggle = page.getByRole("switch", { name: title, exact: true });
      if (!(await toggle.count()))
        throw new Error(
          `capture-evidence feature("${title}"): no switch matched`,
        );
      await apply(page, toggle.first());
    },
  };
}
