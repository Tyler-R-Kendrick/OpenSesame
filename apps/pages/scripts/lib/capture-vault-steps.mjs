/**
 * Capture verbs for a vault with something in it, and for the shell's one
 * text input. An empty vault hides what a list does once it is long enough to
 * scroll, to search and to pass under a corner button.
 */
export function vaultSteps({ press, visit }) {
  return {
    /**
     * Add logins through the editor, one per name, the way a person fills a
     * vault: the lists in a sheet are then long enough to scroll and search.
     */
    async seed(page, names) {
      for (const name of names) {
        await visit(page, "vault/new/login");
        await page.getByLabel("Name", { exact: true }).first().fill(name);
        await press(page.getByRole("button", { name: "Save item" }).first());
        await page.waitForTimeout(900);
      }
    },
    /**
     * Add secrets through the editor, one per `{ name, secret }`: the default
     * kind of a new item. A vault with items in it is what a list, a trip's
     * choice of what stays home and a search all need.
     */
    async secrets(page, items) {
      for (const { name, secret } of items) {
        await visit(page, "vault/new");
        await page.getByLabel("Name", { exact: true }).fill(name);
        await page.getByLabel("Secret value", { exact: true }).fill(secret);
        await press(page.getByRole("button", { name: "Save item" }).first());
        await page.waitForTimeout(900);
      }
    },
    /**
     * Hold a finger on a control as raw touch events, long enough for the
     * app's own long-press recognizer, then lift: the road a phone takes to a
     * context menu.
     */
    async hold(page, selector) {
      const box = await page.locator(selector).first().boundingBox();
      if (!box)
        throw new Error(`capture-evidence hold("${selector}"): not drawn`);
      const cdp = await page.context().newCDPSession(page);
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [at],
      });
      await page.waitForTimeout(900);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await page.waitForTimeout(600);
    },
    /**
     * Type into the shell's command field and run it, the way a person would.
     * Refuses a silent miss: the field is on every unlocked screen.
     */
    async command(page, text) {
      const field = page.locator("#command-bar-input");
      if (!(await field.count()))
        throw new Error("capture-evidence command: no command field is drawn");
      await field.fill(text);
      await field.press("Enter");
      await page.waitForTimeout(900);
    },
  };
}
