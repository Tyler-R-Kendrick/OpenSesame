/**
 * Capture verbs for what sits at the foot of a long panel and for what a
 * control says to a screen reader — both measurements a sheet should read from
 * the browser rather than from memory.
 */
export function footSteps() {
  return {
    /**
     * Bring the foot of whatever scrolls to the bottom. A panel beneath the
     * fold is still a screen someone looks at; the pair then shows what each
     * build keeps at the end of a long page.
     */
    async scrollBottom(page) {
      await page.evaluate(() => {
        for (const node of document.querySelectorAll("*")) {
          const { overflowY } = getComputedStyle(node);
          if (
            /(auto|scroll)/.test(overflowY) &&
            node.scrollHeight > node.clientHeight + 4
          ) {
            node.scrollTop = node.scrollHeight;
          }
        }
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(600);
    },
    /** Print each match's accessible name, one line each: `Notifications — 1 pending`. */
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
