/**
 * J-DURESS: the device's duress code, set from Settings and used where a
 * vault unlocks (ADR 0155) — in the built app, with nothing mocked.
 *
 * The owner turns the code on in Settings › Security, locks, types it at the
 * unlock screen and lands in an empty decoy that shows no Duress row; then
 * goes back to the real vault with its real password, sees the code marked
 * used, clears it, and changes the code.
 */
import {
  PASSWORD,
  openSettingsCategory,
  sealWithPassword,
  waitOpen,
} from "./pages-journey.mjs";

const CODE = "246813579";
const NEXT_CODE = "135792468";

async function setCode(page, code, button) {
  const fields = page.locator("[role=dialog] input[type=password]");
  await fields.nth(0).fill(code);
  await fields.nth(1).fill(code);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: button }).click();
}

const rowText = async (page) =>
  (await page.locator("#duress-profiles").innerText()).replace(/\s+/g, " ");

/** Off until set; a code that is too short cannot be turned on; then it is on. */
async function turnOn({ page, check, snap }) {
  await openSettingsCategory(page, "Security");
  await page.locator("#duress-profiles").waitFor({ timeout: 15000 });
  check(
    !/Duress code is on/.test(await rowText(page)),
    "the duress code is off until it is set",
  );
  // A code that is not eight to twelve digits is refused before anything is sealed.
  await page.getByRole("button", { name: "Add" }).last().click();
  const fields = page.locator("[role=dialog] input[type=password]");
  await fields.nth(0).fill("2468");
  await fields.nth(1).fill("2468");
  await page.getByRole("checkbox").check();
  check(
    await page
      .getByRole("button", { name: "Turn on duress code" })
      .isDisabled(),
    "a four-digit code cannot be turned on",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add" }).last().click();
  await setCode(page, CODE, "Turn on duress code");
  await page.getByText("Duress code is on.").waitFor({ timeout: 15000 });
  await snap(page, "J-DURESS-on");
}

const promptLabel = async (page) =>
  (await page.locator(".rail__prompt:visible").first().innerText())
    .replace(/\s+/g, " ")
    .trim();

const pageText = async (page) =>
  (await page.locator("body").innerText()).replace(/\s+/g, " ");

/** What a decoy must never say: it is read as an ordinary unlock. */
export const TELLS = [
  /Unavailable/,
  /missing_decoy/,
  /Vault locked/,
  /You are a guest/,
  /decoy/i,
  /duress/i,
];

/**
 * Typed where the vault unlocks, the code opens a decoy, never the vault.
 * The page is reloaded first: an armed code lives in the origin's files, and
 * a code that only worked in the tab that set it is no code at all.
 */
async function useCode({ page, check, snap }) {
  const real = await promptLabel(page);
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByLabel("Password", { exact: true })
    .waitFor({ timeout: 15000 });
  await page.getByLabel("Password", { exact: true }).fill(CODE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page).catch(async (error) => {
    const body = await page.evaluate(() => document.body.innerText);
    throw new Error(
      `the code did not open the decoy after a reload: ${body.slice(0, 300)} (${error.message})`,
    );
  });
  await page.waitForTimeout(1000);
  const seen = await pageText(page);
  check(
    !/Unavailable|missing_decoy|Vault locked/.test(seen),
    "the decoy page carries no 'Unavailable', 'missing_decoy' or 'Vault locked'",
  );
  check(
    (await page.locator(".duress-presentation-overlay").count()) === 0,
    "the decoy draws no presentation overlay",
  );
  const label = await promptLabel(page);
  check(
    label === real,
    `the decoy's identity label equals the real unlock's (${label} vs ${real})`,
  );
  await openSettingsCategory(page, "Security");
  await page
    .getByRole("heading", { name: "Unlock methods" })
    .waitFor({ timeout: 15000 });
  check(
    (await page.locator("#duress-profiles").count()) === 0,
    "a decoy session is drawn no Duress row",
  );
  const security = await pageText(page);
  check(
    TELLS.every((tell) => !tell.test(security)),
    "Settings › Security in the decoy never says guest, decoy or duress",
  );
  await openSettingsCategory(page, "Vaults");
  await page
    .getByRole("heading", { name: "Vaults on this device" })
    .waitFor({ timeout: 15000 });
  check(
    /personal\s+sealed/.test(await pageText(page)),
    "Settings › Vaults shows the personal vault, open and sealed, as a real unlock does",
  );
  await snap(page, "J-DURESS-decoy");
}

/** Back to the real vault by its own password; the owner clears, then changes. */
async function comeBack({ page, check, snap }) {
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .click();
  // Locking the decoy lands where a real lock does: the vault's own password.
  await page
    .getByLabel("Password", { exact: true })
    .waitFor({ timeout: 15000 });
  check(
    (await page.getByLabel("Password", { exact: true }).count()) === 1,
    "locking the decoy returns to the vault's own password, not the guest road",
  );
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
  await openSettingsCategory(page, "Security");
  await page.locator("#duress-profiles").waitFor({ timeout: 15000 });
  check(
    /guest's powers/.test(await rowText(page)),
    "the owner sees the code was used, and what that holds",
  );
  await snap(page, "J-DURESS-used");
  await page.getByRole("button", { name: "Clear" }).click();
  await page.getByText("Cleared. The code is still on.").waitFor({
    timeout: 15000,
  });
  check(
    !/guest's powers/.test(await rowText(page)),
    "clearing lifts what the code set off",
  );
  await page.getByRole("button", { name: "Change" }).last().click();
  await setCode(page, NEXT_CODE, "Change duress code");
  await page.getByText("Duress code changed.").waitFor({ timeout: 15000 });
  await snap(page, "J-DURESS-changed");
}

export async function walkJDuress(context) {
  const { page, origin, base } = context;
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await turnOn(context);
  await useCode(context);
  await comeBack(context);
}
