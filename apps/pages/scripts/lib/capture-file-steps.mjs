/**
 * Capture verbs for a key that opens the OS file picker — the vault's
 * Import. A journey names the key and a fixture file under the repository;
 * the picker the key opens is answered with that file, the way a person
 * chooses an export. `press` is `capture-evidence.mjs`'s tap-or-click.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

export function fileSteps({ press }) {
  return {
    /**
     * `{ "pickFileOptional": { "key": "Import items", "file": "docs/…/app.env" } }`.
     * A base build that has no such key is a legitimate difference, not a
     * miss: the pair then shows the key's absence.
     */
    async pickFileOptional(page, { key, file }) {
      const button = page.getByRole("button", { name: key, exact: true });
      if (!(await button.count())) return;
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        press(button.first()),
      ]);
      await chooser.setFiles(path.join(repoRoot, file));
      await page.waitForTimeout(1200);
    },
  };
}
