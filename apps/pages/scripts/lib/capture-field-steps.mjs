/**
 * Capture verbs about sections and fields, kept out of `capture-evidence.mjs`
 * so that script stays inside its size budget. `press` is that script's
 * tap-or-click, so a phone capture taps.
 */
import { openSessionSection } from "./session-section.mjs";

/** Settings and Activity are session roots: the vault rail does not list them. */
const isSessionRoot = (name) => /^(settings|activity)$/i.test(name);

function properName(name) {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

export function fieldSteps({ press }) {
  return {
    /** Open a section: the sections drawer on a phone, else the rail or session menu. */
    async tab(page, name) {
      const key = page.getByRole("button", { name: "Sections" }).first();
      if (await key.count()) {
        await press(key);
        await page.waitForTimeout(450);
        await press(page.locator(".drawer__row", { hasText: name }).first());
      } else if (isSessionRoot(name)) {
        await openSessionSection(page, properName(name));
      } else {
        await press(page.locator(".railtree__row", { hasText: name }).first());
      }
      await page.waitForTimeout(900);
    },
    /**
     * `fill`, for a field only one of the two builds has — a tab the base does
     * not draw is a legitimate difference, not a miss.
     */
    async fillOptional(page, { label, text }) {
      const field = page.getByLabel(label, { exact: true }).first();
      if (!(await field.count())) return;
      await field.fill(text);
      await page.waitForTimeout(300);
    },
  };
}
