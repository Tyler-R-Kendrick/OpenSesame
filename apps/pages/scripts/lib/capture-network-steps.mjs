/**
 * Capture verbs for the network a person is on — a screen that answers
 * differently offline is only evidenced by taking the device offline — and
 * for finding what a reset said about it, wherever the build put it.
 */
export function networkSteps() {
  return {
    /** Lose the connection, the way a phone loses signal: `navigator.onLine` goes false. */
    async goOffline(page) {
      await page.context().setOffline(true);
      await page.waitForTimeout(400);
    },
    /**
     * Look for the reset's panel — the question, or what a reset left
     * behind — and bring it into the middle of the screen. One build keeps
     * it at the card's foot, another at its head; both are pictured showing
     * it. Skipped when there is none.
     */
    async lookForResetPanel(page) {
      const panel = page.locator(".unlock__danger").first();
      if (!(await panel.count())) return;
      await panel.evaluate((node) => {
        node.scrollIntoView({ block: "center", behavior: "instant" });
      });
      await page.waitForTimeout(600);
    },
  };
}
