/**
 * Capture verbs that read a control's size back from the browser, and load the
 * page cold, so a sheet's measurement is a fact the browser printed.
 */
export function metricsSteps() {
  return {
    /**
     * Print each match's box and type size, and whether the page scrolls
     * sideways, so a control's size is read from the browser.
     */
    async metrics(page, selector) {
      const rows = await page.locator(selector).evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          const size = getComputedStyle(node).fontSize;
          return `${Math.round(box.width)}x${Math.round(box.height)} type ${size}`;
        }),
      );
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      console.log(
        `  metrics ${selector}: ${rows.join(" | ") || "none"}; sideways scroll: ${wide}`,
      );
    },
    /** A cold load of the page as it is: no guest road taken, no unlock. */
    async coldLoad(page) {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(5200);
    },
  };
}
