/**
 * Capture verbs for a vault that begins from a file (ADR 0188): choose a
 * file at the front door, then seal the vault it is for. Both are for a
 * branch that has the road, so a journey marks them `"only": "after"`; the
 * base build has no file input on the door to answer.
 */

import { PIN, waitOpen } from "./pages-journey.mjs";

export function importSteps() {
  return {
    /**
     * `{ "chooseFile": { "name": "app.env", "text": "A=1\n" } }` — answer the
     * file picker the door's Import road opens, with a fixture written in the
     * journey. No such input is a miss, not a quieter picture.
     */
    async chooseFile(page, { name, text }) {
      const input = page.getByLabel("Choose a file to import");
      if (!(await input.count()))
        throw new Error(
          `capture-evidence chooseFile("${name}"): no file input on this screen — refusing a silent miss`,
        );
      await input.setInputFiles({
        name,
        mimeType: "text/plain",
        buffer: Buffer.from(text),
      });
      await page.waitForTimeout(900);
    },
    /** Seal the vault on the seal screen with the journey's PIN, and wait for it to open. */
    async sealHere(page) {
      await page.getByRole("tab", { name: "PIN" }).click();
      await page.getByLabel("Device PIN", { exact: true }).fill(PIN);
      await page.getByLabel("Confirm PIN", { exact: true }).fill(PIN);
      await page
        .getByLabel("I understand this vault cannot be recovered.", {
          exact: true,
        })
        .check();
      await page.getByRole("button", { name: "Seal with PIN" }).click();
      await waitOpen(page);
      await page.waitForTimeout(1600);
    },
  };
}
