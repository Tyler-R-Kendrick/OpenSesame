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
