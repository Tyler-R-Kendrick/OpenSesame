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
    /** Press the tab with exactly this name, when this build draws one. */
    async tabNamedOptional(page, name) {
      const tab = page.getByRole("tab", { name, exact: true }).first();
      if (!(await tab.count()) || !(await tab.isEnabled())) return;
      await press(tab);
      await page.waitForTimeout(500);
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
    /**
     * Open the Identity sheet from the top bar's overflow key and leave it
     * open. A desktop draws no top bar (it appears below 901px), so the
     * window narrows for the visit and widens again after, with no reload.
     */
    async identitySheet(page) {
      await openIdentitySheet(page, press);
    },
    /**
     * Connect the device to Identity the way a person does: the sheet's
     * Use this device, which closes the sheet once the session is open.
     */
    async connectIdentity(page) {
      const sheet = await openIdentitySheet(page, press);
      await press(sheet.getByRole("button", { name: "Use this device" }));
      await sheet.waitFor({ state: "detached", timeout: 15000 });
      await restoreWidth(page);
    },
    /** Put the window back to its width after an Identity visit narrowed it. */
    async widen(page) {
      await restoreWidth(page);
    },
  };
}

const narrowedFrom = new WeakMap();

async function restoreWidth(page) {
  const wide = narrowedFrom.get(page);
  if (!wide) return;
  narrowedFrom.delete(page);
  await page.setViewportSize(wide);
  await page.waitForTimeout(600);
}

async function openIdentitySheet(page, press) {
  const size = page.viewportSize();
  if (size && size.width > 900 && !narrowedFrom.has(page)) {
    narrowedFrom.set(page, size);
    await page.setViewportSize({ width: 700, height: size.height });
    await page.waitForTimeout(600);
  }
  await press(page.getByRole("button", { name: /^More —/ }).first());
  await press(page.locator(".conn", { hasText: "Identity" }).first());
  const sheet = page.getByRole("dialog", { name: "Identity connection" });
  await sheet.waitFor({ timeout: 10000 });
  return sheet;
}
