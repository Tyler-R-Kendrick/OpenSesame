/**
 * The capture verbs kept outside `capture-evidence.mjs`: menus and settings
 * files, the ceremonies a link opens, and places the two builds draw
 * differently. `press` is that script's tap-or-click, so a phone capture taps.
 */
import { ceremonySteps } from "./capture-ceremony-steps.mjs";
import { menuSteps } from "./capture-menu-steps.mjs";
import { placeSteps } from "./capture-place-steps.mjs";

export function extraSteps({ press }) {
  return {
    ...menuSteps({ press }),
    ...ceremonySteps({ press }),
    ...placeSteps(),
    /**
     * Pick a labelled radio when this build has it — a connector's
     * connection method. A base build without the choice is a legitimate
     * difference, not a miss.
     */
    async chooseOptional(page, name) {
      const radio = page.getByRole("radio", { name, exact: true }).first();
      if ((await radio.count()) && (await radio.isEnabled())) {
        await press(radio);
        await page.waitForTimeout(500);
      }
    },
  };
}
