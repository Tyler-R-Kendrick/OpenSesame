/**
 * J-NAV: record a key on Settings › Keybindings, command-bar setting search,
 * source typing does not fire global chords, the key survives a reload.
 * Settings › General does not pin an approvals view.
 */
import {
  lockVault,
  openConfigFile,
  openConfigForm,
  openGeneral,
  runCommand,
  sealWithPassword,
  unlockWithPassword,
} from "./pages-journey.mjs";

const RAW = 'textarea[aria-label="settings/keybindings/config.yaml"]';

/** The Keybindings tab, reached the way a person reaches it. */
async function openKeybindings(page) {
  await openGeneral(page);
  await openConfigForm(page, "Keybindings");
  await page
    .getByRole("heading", { name: "Keymap" })
    .waitFor({ timeout: 8000 });
}

export async function walkJNav({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await openGeneral(page);
  // Pending approvals are an Access › Requests concern, not a setting.
  check(
    (await page.getByLabel("Pin approvals view").count()) === 0,
    "Settings › General carries no approvals view",
  );
  await openKeybindings(page);
  // Record `w` for Next row by pressing it, the way a person does: the field
  // keeps the key once the keymap's own timeout lapses.
  await page.getByRole("button", { name: "Add a key for Next row" }).click();
  await page.keyboard.press("w");
  await page
    .getByRole("button", { name: "Change w for Next row" })
    .waitFor({ timeout: 8000 });
  check(
    (await page
      .getByRole("button", { name: "Change w for Next row" })
      .count()) === 1,
    "the recorded key is drawn as one keycap on Next row",
  );
  const opened = await runCommand(page, "autoLockMinutes");
  check(
    /Opened autoLockMinutes/i.test(opened),
    `palette reaches setting: ${opened}`,
  );
  await openConfigFile(page, "keybindings");
  const source = page.locator(RAW);
  await source.waitFor({ timeout: 8000 });
  check(
    /^\s*w: listing\.next\b/m.test(await source.inputValue()),
    "the recorded key is written in keybindings/config.yaml",
  );
  await source.click();
  await page.keyboard.type("j");
  check(
    (await source.inputValue()).includes("j"),
    "typing j in Source stays in the editor",
  );
  await snap(page, "J-NAV-source-typing");
  await lockVault(page);
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPassword(page);
  await openKeybindings(page);
  check(
    (await page
      .getByRole("button", { name: "Change w for Next row" })
      .count()) === 1,
    "the recorded key survived unlock/reload",
  );
}
