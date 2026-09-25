/**
 * Capture verbs that change what a device has switched on — a capability's
 * own switch, or a whole section's, then Settings › Capabilities' Apply
 * (ADR 0130) — kept beside `capture-evidence.mjs`'s own. `press` is that
 * script's tap-or-click; `openSettings(page, name)` opens a Settings page.
 */
import { capabilityOffSwitch } from "./always-on.mjs";

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
     * Switch an optional capability on, by its catalog title. An always-on
     * one has no switch: skipped.
     */
    async enable(page, title) {
      await openSettings(page, "Capabilities");
      const add = capabilityOffSwitch(page, title);
      if (await add.count()) await apply(page, add.first());
    },
    /** A whole section, by its own switch — what a person actually turns on. */
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
