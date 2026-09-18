/**
 * J-NAV: remap a safe action, pin a saved view, command-bar setting search,
 * source typing does not fire global chords, remap survives reload.
 */
import {
  lockVault,
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

export async function walkJNav({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await openGeneral(page);
  await setTextarea(page, "#keybindings-source", REMAPPED);
  await page.getByRole("button", { name: "Save keybindings" }).click();
  await page.getByText(/Keybindings saved/).waitFor({ timeout: 8000 });
  await page.getByRole("button", { name: "Pin view" }).click();
  await page
    .getByText(/Pinned pending-approvals view/)
    .waitFor({ timeout: 8000 });
  check(true, "saved bindings and pinned view");
  const opened = await runCommand(page, "autoLockMinutes");
  check(
    /Opened autoLockMinutes/i.test(opened),
    `palette reaches setting: ${opened}`,
  );
  await page.getByRole("button", { name: "Source", exact: true }).click();
  const prefs = page.locator("textarea#prefs-source");
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
  const stored = await page.locator("#keybindings-source").inputValue();
  check(stored.includes('"j": "item.edit"'), "remap survived unlock/reload");
  check(
    /pending-approvals|saved view/i.test(
      await page.locator("body").innerText(),
    ),
    "pinned view still listed",
  );
}
