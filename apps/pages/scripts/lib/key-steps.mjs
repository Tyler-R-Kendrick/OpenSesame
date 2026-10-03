/**
 * Keys pressed on the page itself, not in a capture field: what a person at
 * the keyboard does before the shell's handler reads a half-typed sequence.
 */
export function keySteps() {
  return {
    /**
     * Press keys on the page, then wait `wait` ms. A field that holds focus is
     * blurred first: a key pressed there would be typed, not read by the shell.
     */
    async keysOptional(page, { keys, wait = 0 }) {
      const typing = await page.evaluate(() => {
        const node = document.activeElement;
        return (
          node instanceof HTMLInputElement ||
          node instanceof HTMLTextAreaElement ||
          node instanceof HTMLSelectElement
        );
      });
      if (typing) await page.evaluate(() => document.activeElement?.blur());
      for (const key of keys) await page.keyboard.press(key);
      await page.waitForTimeout(wait);
    },
  };
}
