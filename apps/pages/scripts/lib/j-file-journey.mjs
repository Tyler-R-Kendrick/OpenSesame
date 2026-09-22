/**
 * J-FILE: the Settings section and settings/general.yaml reach the same
 * draft; ledger path guesses are refused in the command bar.
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
  check(
    (await page.getByRole("heading", { name: "Settings" }).count()) === 1,
    "Settings section shows its heading",
  );
  await page.getByRole("button", { name: "YAML", exact: true }).click();
  const path = page.locator(".set-raw__path");
  await path.waitFor({ timeout: 8000 });
  check(
    (await path.innerText()).includes("settings/general.yaml"),
    "general.yaml is the document this section edits",
  );
  await snap(page, "J-FILE-yaml");
  await page.getByRole("button", { name: "Form", exact: true }).click();
  await page
    .getByRole("heading", { name: "Keybindings and views" })
    .waitFor({ timeout: 8000 });
  check(
    (await page.getByLabel("Clear copied secrets after").count()) > 0,
    "the same draft is reachable as Form fields",
  );
  await snap(page, "J-FILE-form");
  const opened = await runCommand(page, "settings/prefs.yaml");
  check(/Opened/i.test(opened), `command bar opens the prefs alias: ${opened}`);
  await page
    .getByRole("heading", { name: "Settings" })
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
    .getByRole("heading", { name: "Keybindings and views" })
    .waitFor({ timeout: 8000 });
  check(true, "General link still reaches the same draft");
}
