/**
 * Capture verbs that read a form back from the browser, or fill one only a
 * build still draws. A sheet's measurement is then a fact the browser printed,
 * not something written from the diff.
 */
export function readSteps() {
  return {
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
  };
}
