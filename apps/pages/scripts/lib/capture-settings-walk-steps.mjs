/**
 * Capture verbs for the second Settings walk (docs/evidence/2026-10-03-settings-walk):
 * the sheet, label and disabled-key readings a walk of Security and Settings
 * needs.
 */

import { pluginSteps } from "./capture-plugin-steps.mjs";

/** The plugin pairing verbs and the Settings walk verbs, as one registration. */
export function pluginAndWalkSteps() {
  return { ...pluginSteps(), ...settingsWalkSteps() };
}

function settingsWalkSteps() {
  return {
    /**
     * Type into the labelled input of the open sheet — never the sheet itself,
     * whose own label can be the same word (the PIN sheet's field is "PIN").
     */
    async sheetFill(page, { label, text }) {
      const field = page
        .locator("[role=dialog]")
        .locator("input")
        .and(page.getByLabel(label, { exact: true }))
        .first();
      if (!(await field.count()))
        throw new Error(
          `capture-evidence sheetFill("${label}"): no input matched — refusing a silent miss`,
        );
      await field.fill(text);
      await page.waitForTimeout(300);
    },
    /**
     * Print the text of the open sheet, one line, so a sheet's sentence is
     * read from the browser and not from the diff.
     */
    async sheetText(page) {
      const text = await page
        .locator("[role=dialog]")
        .first()
        .evaluate((node) => node.textContent.replaceAll(/\s+/g, " ").trim())
        .catch(() => "no sheet");
      console.log(`  sheet: ${text}`);
    },
    /** Print each match's accessible name (a mark's sentence lives in its aria-label). */
    async labels(page, selector) {
      const names = await page
        .locator(selector)
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-label") ?? ""),
        );
      console.log(`  labels ${selector}: ${names.join(" | ")}`);
    },
    /** Print how many of the page's own buttons are disabled, and their names. */
    async disabledKeys(page, scope) {
      const names = await page
        .locator(`${scope} button:disabled, ${scope} input:disabled`)
        .evaluateAll((nodes) =>
          nodes.map(
            (node) =>
              node.getAttribute("aria-label") ||
              node.getAttribute("title") ||
              node.textContent.trim() ||
              node.tagName.toLowerCase(),
          ),
        );
      console.log(
        `  disabled in ${scope}: ${names.length} ${names.length ? `(${names.join(" | ")})` : ""}`,
      );
    },
  };
}
