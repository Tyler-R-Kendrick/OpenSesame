/**
 * The capture verbs kept outside `capture-evidence.mjs`: menus and settings
 * files, the ceremonies a link opens, and places the two builds draw
 * differently. `press` is that script's tap-or-click, so a phone capture taps.
 */
import { approvalSteps } from "./capture-approval-steps.mjs";
import { ceremonySteps } from "./capture-ceremony-steps.mjs";
import { factorSteps } from "./capture-factor-steps.mjs";
import { fileSteps } from "./capture-file-steps.mjs";
import { invokeSteps } from "./capture-invoke-steps.mjs";
import { markSteps } from "./capture-mark-steps.mjs";
import { memberSteps } from "./capture-member-steps.mjs";
import { menuSteps } from "./capture-menu-steps.mjs";
import { networkSteps } from "./capture-network-steps.mjs";
import { orgSignInSteps } from "./capture-org-signin-steps.mjs";
import { placeSteps } from "./capture-place-steps.mjs";
import { railSteps } from "./capture-rail-steps.mjs";
import { routingSteps } from "./capture-routing-steps.mjs";
import { unlockWithPassword } from "./pages-journey.mjs";

export function extraSteps({ press }) {
  return {
    ...menuSteps({ press }),
    ...ceremonySteps({ press }),
    ...approvalSteps(),
    ...factorSteps({ press }),
    ...fileSteps({ press }),
    ...invokeSteps(),
    ...markSteps({ press }),
    ...memberSteps({ press }),
    ...placeSteps(),
    ...railSteps(),
    ...routingSteps(),
    ...orgSignInSteps(),
    ...networkSteps(),
    /**
     * Reload the page and open the sealed password vault again, for a change
     * a device only picks up on a cold load (a section a capability adds).
     */
    async reloadUnlock(page) {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(5200);
      await unlockWithPassword(page);
      await page.waitForTimeout(1400);
    },
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
    /**
     * Choose an option in a labelled native select, by its visible text —
     * a grant's resource kind, connector or policy. A select or option this
     * build does not have is a failure, not a quieter picture.
     */
    async select(page, { label, option }) {
      const field = page.getByLabel(label, { exact: true }).first();
      if (!(await field.count()))
        throw new Error(
          `capture-evidence select("${label}"): no field matched — refusing a silent miss`,
        );
      await field.selectOption({ label: option });
      await page.waitForTimeout(400);
    },
    /**
     * Choose an option in a labelled select when this build has it — a
     * device's platform. A base build without the field is a legitimate
     * difference, not a miss.
     */
    async selectOptional(page, { label, value }) {
      const select = page.getByLabel(label, { exact: true }).first();
      if ((await select.count()) && (await select.isEnabled())) {
        await select.selectOption(value);
        await page.waitForTimeout(400);
      }
    },
    /**
     * Type into a labelled field when this build has it — an endpoint a base
     * build asks for somewhere else. A missing field is a legitimate
     * difference, not a miss.
     */
    async fillOptional(page, { label, text }) {
      const field = page.getByLabel(label, { exact: true }).first();
      if (!(await field.count()) || !(await field.isEnabled())) return;
      // A label can name a key in the other build; only a real field is filled.
      if (!(await field.evaluate((node) => node.matches("input, textarea"))))
        return;
      await field.fill(text);
      await page.waitForTimeout(300);
    },
  };
}
