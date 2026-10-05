/** Tapping by selector, for what a journey cannot reach by accessible name. */
export function tapStep({ press }) {
  return {
    /**
     * Tap an element by selector — for two controls that share an accessible
     * name (a prompt's account and vault segments both read "guest-1"). A
     * `[selector, x, y]` taps that point of it, so a full-screen backdrop can
     * be dismissed from a corner rather than from its middle.
     */
    async tap(page, target) {
      const [selector, x, y] = [target].flat();
      const el = page.locator(selector).first();
      await (x === undefined ? press(el) : el.click({ position: { x, y } }));
      await page.waitForTimeout(700);
    },
  };
}
