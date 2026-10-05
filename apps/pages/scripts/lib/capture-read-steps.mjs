/**
 * Capture verbs that read a form back from the browser, or fill one only a
 * build still draws. A sheet's measurement is then a fact the browser printed,
 * not something written from the diff.
 */
import { TOUCH_COPY } from "./touch-copy-contract.mjs";

export function readSteps() {
  return {
    /**
     * Print how many elements match each selector, so a sheet's before/after
     * numbers are read from the browser rather than from the diff.
     */
    async count(page, selectors) {
      for (const selector of [selectors].flat()) {
        const n = await page.locator(selector).count();
        console.log(`  count ${selector}: ${n}`);
      }
    },
    /**
     * `fill`, for a field only one of the two builds draws: a form the base
     * still offers and the branch has rightly withdrawn. Matches the label as
     * a substring and takes the first, so "API key" finds the required one.
     */
    async fillOptional(page, { label, text }) {
      const field = page.getByLabel(label).first();
      if (!(await field.count())) return;
      await field.fill(text);
      await page.waitForTimeout(300);
    },
    /**
     * Choose an option of a labelled select (exact label) when this build
     * draws it: a choice the base does not offer is a legitimate difference.
     */
    async selectOptional(page, { label, value }) {
      const field = page.getByLabel(label, { exact: true }).first();
      if (!(await field.count())) return;
      await field.selectOption(value);
      await page.waitForTimeout(300);
    },
    /**
     * Print each matched field's name and whether it holds text — never the
     * text itself, since a field may be a secret. What a form kept or wiped
     * is then read from the browser.
     */
    async values(page, selector) {
      const rows = await page
        .locator(selector)
        .evaluateAll((nodes) =>
          nodes.map(
            (node) => `${node.name}=${node.value === "" ? "empty" : "filled"}`,
          ),
        );
      console.log(`  values ${selector}: ${rows.join(" | ") || "none"}`);
    },
    /**
     * Print the accessible name of each match: a status mark's sentence lives
     * in its label, so what it says is read from the browser.
     */
    async labels(page, selector) {
      const names = await page
        .locator(selector)
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-label") ?? ""),
        );
      console.log(`  labels ${selector}: ${names.join(" | ") || "none"}`);
    },
    /**
     * Print what keyboard-only copy is drawn right now: the gv chip, every
     * keys-voice line, the visible tip and key lines as the person reads them,
     * and whether the command bar's placeholder fits its field.
     */
    async touchCopy(page) {
      const seen = await page.evaluate(TOUCH_COPY);
      const lines = await page
        .locator(".empty__tip, .buffer__keys")
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => node.getClientRects().length > 0)
            .map(
              (node) =>
                [...node.querySelectorAll("span")]
                  .filter((span) => getComputedStyle(span).display !== "none")
                  .map((span) => span.textContent)
                  .join("")
                  .trim() || node.textContent.trim(),
            ),
        );
      console.log(`  gv chips drawn: ${seen.jump}`);
      console.log(`  keys-voice lines drawn: ${seen.keysVoice}`);
      console.log(`  key and tip lines read: ${lines.join(" | ") || "none"}`);
      if (seen.bar) {
        const { placeholder, text, room, scrollWidth, clientWidth } = seen.bar;
        console.log(
          `  command bar placeholder: "${placeholder}" text ${text}px in ${room}px (scrollWidth ${scrollWidth}, clientWidth ${clientWidth}) -> ${text <= room ? "fits" : "TRUNCATED"}`,
        );
      } else console.log("  command bar placeholder: not drawn");
    },
    /** The vault's list pane on a phone, the way a thumb reaches it. */
    async openList(page) {
      const all = page.getByRole("treeitem", { name: /^all\b/i }).first();
      if (await all.count()) {
        await all.tap();
        await page.waitForTimeout(900);
      }
    },
  };
}
