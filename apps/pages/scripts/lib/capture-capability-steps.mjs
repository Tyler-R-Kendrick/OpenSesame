/**
 * Capture verbs that change what a device has switched on — a capability's
 * own switch, or a whole section's. Settings commits that switch in place
 * (ADR 0130) — kept beside `capture-evidence.mjs`'s own. `press` is that
 * script's tap-or-click; `openSettings(page, name)` opens a Settings page.
 */
import { capabilityOffSwitch } from "./always-on.mjs";

/**
 * Open the page that holds the switches: Settings › Features. A capture walks
 * the base build and this one the same way (AGENTS.md §5), and a base from
 * before the split (ADR 0189) names that page Capabilities, so it is asked for
 * by its old name when there is no Features page to land on.
 */
export async function openFeatures(openSettings, page) {
  await openSettings(page, "Features");
  if ((await page.getByTestId("features-panel").count()) === 0)
    await openSettings(page, "Capabilities");
}

export function capabilitySteps({ press, openSettings }) {
  /** Press a Settings › Features switch. It commits in place. */
  async function apply(page, control) {
    await press(control);
    await page.waitForTimeout(400);
    if ((await page.getByTestId("capability-review").count()) !== 0) {
      throw new Error("Settings › Features opened a review");
    }
    await page.waitForTimeout(600);
  }

  return {
    /** Install an item pack through the person's Vaults settings switch. */
    async itemPack(page, title) {
      await openSettings(page, "Vaults");
      const control = page.getByRole("switch", { name: title, exact: true });
      await control.waitFor();
      if ((await control.getAttribute("aria-checked")) === "false")
        await press(control);
      await page.waitForFunction((name) => {
        const toggle = [...document.querySelectorAll('[role="switch"]')].find(
          (node) => node.getAttribute("aria-label") === name,
        );
        return (
          toggle?.getAttribute("aria-checked") === "true" &&
          toggle?.getAttribute("aria-busy") !== "true"
        );
      }, title);
    },
    /**
     * `scrollToOptional`, with the heading in the middle of the viewport: a
     * sticky strip above the list hides a heading brought to the top, and a
     * phone's strip is tall.
     */
    async centerOptional(page, name) {
      const heading = page
        .getByRole("heading", { name: new RegExp(name, "i") })
        .first();
      if (!(await heading.count())) return;
      await heading.evaluate((node) => {
        node.scrollIntoView({ block: "center", behavior: "instant" });
      });
      await page.waitForTimeout(600);
    },
    /**
     * Switch an optional capability on, by its catalog title. An always-on
     * one has no switch: skipped.
     */
    async enable(page, title) {
      await openFeatures(openSettings, page);
      const add = capabilityOffSwitch(page, title);
      if (await add.count()) await apply(page, add.first());
    },
    /**
     * Switch an optional capability on. Settings commits in place, so the
     * page stays on the connector list.
     */
    async propose(page, title) {
      await openFeatures(openSettings, page);
      const add = capabilityOffSwitch(page, title);
      if (!(await add.count()))
        throw new Error(
          `capture-evidence propose("${title}"): no off switch matched`,
        );
      await press(add.first());
      await page.waitForTimeout(400);
      if ((await page.getByTestId("capability-review").count()) !== 0) {
        throw new Error(
          `capture-evidence propose("${title}"): a review opened`,
        );
      }
    },
    /**
     * `feature`, for a section only one of the two builds has: the base
     * that has not grown it yet is a legitimate difference, not a miss.
     */
    async featureOptional(page, title) {
      await openFeatures(openSettings, page);
      const toggle = page.getByRole("switch", { name: title, exact: true });
      if (await toggle.count()) await apply(page, toggle.first());
    },
    /** A whole section, by its own switch — what a person actually turns on. */
    async feature(page, title) {
      await openFeatures(openSettings, page);
      const toggle = page.getByRole("switch", { name: title, exact: true });
      if (!(await toggle.count()))
        throw new Error(
          `capture-evidence feature("${title}"): no switch matched`,
        );
      await apply(page, toggle.first());
    },
  };
}
