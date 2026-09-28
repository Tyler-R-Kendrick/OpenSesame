/**
 * Capture verbs for a key that opens the OS file picker — the vault's
 * Import. A journey names the key and a fixture file under the repository;
 * the picker the key opens is answered with that file, the way a person
 * chooses an export. `press` is `capture-evidence.mjs`'s tap-or-click.
 */
import { writeFileSync } from "node:fs";
import os from "node:os";
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
    /**
     * `{ "setFile": { "label": "Choose the travel bundle", "name": "x.json",
     * "bytes": 68157440 } }` — hand a labelled file input a file of that
     * size, the way a person picks the wrong, very large file. Written to
     * the temp directory: Playwright takes a path, not a buffer, past 50 MB.
     * `{ "setFile": { "label": …, "file": "docs/…/x.json" } }` hands it a
     * file from the repository instead.
     */
    async setFile(page, { label, name, bytes, file: fixture }) {
      const input = page.getByLabel(label, { exact: true }).first();
      if (!(await input.count()))
        throw new Error(
          `capture-evidence setFile("${label}"): no input matched — refusing a silent miss`,
        );
      if (fixture) {
        await input.setInputFiles(path.join(repoRoot, fixture));
        await page.waitForTimeout(1500);
        return;
      }
      const file = path.join(os.tmpdir(), name);
      writeFileSync(file, Buffer.alloc(bytes, 0x20));
      await input.setInputFiles(file);
      await page.waitForTimeout(1500);
    },
  };
}
