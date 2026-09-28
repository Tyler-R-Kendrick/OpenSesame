/**
 * J-NAV: remap a safe action, command-bar setting search,
 * source typing does not fire global chords, remap survives reload.
 */
import {
  lockVault,
  openConfigFile,
  openGeneral,
  runCommand,
  sealWithPassword,
  setTextarea,
  unlockWithPassword,
} from "./pages-journey.mjs";

const REMAPPED = `{
  "Control+l": "command.palette",
  ":": "command.palette",
  "/": "listing.search",
  "j": "item.edit",
  "x": "item.trash",
  "s": "item.share",
  "e": "item.edit",
  "?": "help.keymap"
}`;
const KEYBINDINGS = "#keybindings-source";
const RAW = 'textarea[aria-label="settings/general/config.yaml"]';

export async function walkJNav({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await openGeneral(page);
  await setTextarea(page, KEYBINDINGS, REMAPPED);
  await page.getByRole("button", { name: "Save keybindings" }).click();
  await page.getByText(/Keybindings saved/).waitFor({ timeout: 8000 });
  check(true, "saved bindings");
  const opened = await runCommand(page, "autoLockMinutes");
  check(
    /Opened autoLockMinutes/i.test(opened),
    `palette reaches setting: ${opened}`,
  );
  await openConfigFile(page, "general");
  const prefs = page.locator(RAW);
  await prefs.waitFor({ timeout: 8000 });
  await prefs.click();
  await page.keyboard.type("j");
  check(
    (await prefs.inputValue()).includes("j"),
    "typing j in Source stays in the editor",
  );
  await snap(page, "J-NAV-source-typing");
  await lockVault(page);
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPassword(page);
  await openGeneral(page);
  const stored = await page.locator(KEYBINDINGS).inputValue();
  // keybindings.yaml is written as YAML; the JSON typed above still reads.
  check(
    /^\s*"?j"?: "?item\.edit"?,?$/m.test(stored),
    "remap survived unlock/reload",
  );
  // Pending approvals are an Access › Requests concern, not a setting.
  check(
    (await page.getByLabel("Pin approvals view").count()) === 0,
    "Settings › General carries no approvals view",
  );
}
