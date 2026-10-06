/**
 * Settings' files, reached with the keyboard alone (AGENTS.md § keyboard
 * access). A painted file is a transparent textarea over its own painted
 * copy, so the textarea draws no focus ring of its own and a read-only file
 * draws no caret: the one sign of where the keys go is the rule the stage
 * draws under it. Nothing but a real browser says whether that rule shows, so
 * this walks to the textarea with Tab and compares the stage's computed
 * border and shadow focused against unfocused.
 *
 * Two arrivals, neither with a click, injected focus or synthetic key — a cold
 *     load of the file's own address, which is what a link or a bookmark
 *     leaves, then the front door's guest road, then Tab to the file:
 *   - the read-only built-in, `settings/vaults?file=…/builtin/secret.json`;
 *   - a new draft, which is editable, `settings/vaults?file=…/installed/new.json`.
 * Shift+Tab then leaves the file and the cue goes back to the unfocused one.
 *
 * A page's own document (`settings?file=config.yaml`) is not one of these: it
 * is the page, so a cold load of it must draw the page and no text editor.
 */
import { expect } from "@playwright/test";

const BUILTIN = "settings/item-types/builtin/secret.json";
const DRAFT = "settings/item-types/installed/new.json";

/** What the stage paints under its text: the only visible cue. */
function cueOf(page) {
  return page.evaluate(() => {
    const stage = document.querySelector(".set-raw__stage");
    const style = stage && getComputedStyle(stage);
    return {
      border: style?.borderBottomColor ?? null,
      shadow: style?.boxShadow ?? null,
      focused: stage?.contains(document.activeElement) ?? false,
    };
  });
}

/**
 * Record a claim and say so aloud when it fails: the keyboard journey ends
 * with one error and no list, and the walk goes on to the next file first.
 */
function must(harness, condition, message) {
  harness.check(condition, message);
  if (!condition) console.error(`FAIL ${message}`);
}

const differs = (a, b) => a.border !== b.border || a.shadow !== b.shadow;

/** Tab (or Shift+Tab) until `target` has the focus. */
async function reach(page, target, key = "Tab") {
  for (let step = 0; step < 200; step++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press(key);
  }
  throw new Error(
    `${key} cannot reach ${await target.getAttribute("aria-label")}`,
  );
}

/** Guest entry from the front door, which lands on "Set up your own". */
async function enterAsGuest(page) {
  await expect(
    page.getByRole("button", { name: "Set up your own" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Skip sign-in and continue as guest" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
}

/** The file is open: Tab onto it, the cue shows, Shift+Tab off it, it goes. */
async function cueFollowsFocus(harness, page, path, label, { readOnly }) {
  const field = page.getByRole("textbox", { name: path, exact: true });
  await expect(field).toHaveCount(1);
  await expect(field).toHaveJSProperty("readOnly", readOnly);
  const resting = await cueOf(page);
  must(harness, !resting.focused, `${label}: the file starts unfocused`);
  await reach(page, field);
  const focused = await cueOf(page);
  must(harness, focused.focused, `${label}: Tab reached the file`);
  must(
    harness,
    differs(resting, focused),
    `${label}: focus draws no cue on the stage (border ${resting.border}, shadow ${resting.shadow} both focused and not)`,
  );
  await page.keyboard.press("Shift+Tab");
  await expect(field).not.toBeFocused();
  const left = await cueOf(page);
  must(
    harness,
    !differs(resting, left),
    `${label}: leaving the file leaves its cue behind (${left.border} ${left.shadow})`,
  );
  // Tab from where Shift+Tab left reaches the file again: it is in the order.
  await page.keyboard.press("Tab");
  await expect(field).toBeFocused();
}

export async function settingsFileKeyboardContract({
  harness,
  browser,
  origin,
  base,
  width,
}) {
  let before = harness.failures.length;
  {
    const { page, context } = await harness.newPage(browser);
    await page.setViewportSize({ width, height: 900 });
    // The built-ins are not listed on the Form any more, so the arrival is the
    // address a link or a bookmark leaves: a cold load of the file itself.
    await page.goto(
      `${origin}${base}settings/vaults?file=${encodeURIComponent(BUILTIN)}`,
      { waitUntil: "networkidle" },
    );
    await enterAsGuest(page);
    await expect(page).toHaveURL(/file=settings%2Fitem-types%2Fbuiltin/);
    await cueFollowsFocus(harness, page, BUILTIN, `${width}px built-in`, {
      readOnly: true,
    });
    await context.close();
    if (harness.failures.length === before)
      console.log(
        `PASS ${width}px: a read-only settings file shows its focus cue, reached by keyboard`,
      );
  }
  before = harness.failures.length;
  {
    const { page, context } = await harness.newPage(browser);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      `${origin}${base}settings/vaults?file=${encodeURIComponent(DRAFT)}`,
      { waitUntil: "networkidle" },
    );
    await enterAsGuest(page);
    await expect(page).toHaveURL(
      /file=settings%2Fitem-types%2Finstalled%2Fnew/,
    );
    await cueFollowsFocus(harness, page, DRAFT, `${width}px new draft`, {
      readOnly: false,
    });
    await context.close();
    if (harness.failures.length === before)
      console.log(
        `PASS ${width}px: an editable settings file shows its focus cue, reached by keyboard from a cold deep link`,
      );
  }
  before = harness.failures.length;
  {
    const { page, context } = await harness.newPage(browser);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}${base}settings?file=config.yaml`, {
      waitUntil: "networkidle",
    });
    await enterAsGuest(page);
    await expect(page).toHaveURL(/\/settings\?file=config\.yaml$/);
    const drawn = await page.evaluate(() => ({
      page: document.querySelector(".set__nav") !== null,
      editor: document.querySelector(".set-raw__stage") !== null,
    }));
    must(
      harness,
      drawn.page && !drawn.editor,
      `${width}px config.yaml: a cold load draws the page, not a text editor (page ${drawn.page}, editor ${drawn.editor})`,
    );
    await context.close();
    if (harness.failures.length === before)
      console.log(
        `PASS ${width}px: config.yaml opens as the page from a cold deep link`,
      );
  }
}
