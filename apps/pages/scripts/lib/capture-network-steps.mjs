/**
 * Capture verbs for the network a person is on: a screen that answers
 * differently offline is only evidenced by taking the device offline.
 */
export function networkSteps() {
  return {
    /** Lose the connection, the way a phone loses signal: `navigator.onLine` goes false. */
    async goOffline(page) {
      await page.context().setOffline(true);
      await page.waitForTimeout(400);
    },
  };
}
