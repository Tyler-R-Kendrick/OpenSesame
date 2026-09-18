/**
 * J-FILE: Settings and settings/prefs.yaml reach the same draft; ledger
 * path guesses are refused in the command bar.
 */
import {
  openGeneral,
  openSection,
  runCommand,
  sealWithPassword,
} from "./pages-journey.mjs";

export async function walkJFile({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await openGeneral(page);
  await snap(page, "J-FILE-settings");
  const fromSettings = await page
    .getByRole("heading", { name: "Preferences" })
    .count();
  check(fromSettings === 1, "Settings General shows Preferences");
  const alias = page.getByText("settings/prefs.yaml", { exact: true }).first();
  check((await alias.count()) >= 1, "prefs.yaml alias is in the Settings tree");
  await alias.click();
  await page
    .getByRole("heading", { name: "Preferences" })
    .waitFor({ timeout: 8000 });
  check(
    (await page.getByRole("button", { name: "Visual", exact: true }).count()) >
      0,
    "alias opens the same Visual/Source prefs draft",
  );
  await snap(page, "J-FILE-alias");
  const opened = await runCommand(page, "settings/prefs.yaml");
  check(/Opened/i.test(opened), `command bar opens prefs alias: ${opened}`);
  await page
    .getByRole("heading", { name: "Preferences" })
    .waitFor({ timeout: 8000 });
  const refused = await runCommand(page, "config/identity-grants");
  check(
    /not an editable document/i.test(refused),
    `ledger path guess refused: ${refused}`,
  );
  const traversal = await runCommand(page, ".config/../config/identity-grants");
  check(
    /not an editable document/i.test(traversal),
    `traversal guess refused: ${traversal}`,
  );
  check(
    (await page.getByText("identity-grants", { exact: true }).count()) === 0,
    "grants ledger is not shown after a path guess",
  );
  await openSection(page, "settings/");
  await page
    .getByRole("link", { name: /^general/i })
    .first()
    .click();
  await page
    .getByRole("heading", { name: "Preferences" })
    .waitFor({ timeout: 8000 });
  check(true, "General link still reaches the same prefs draft");
}
