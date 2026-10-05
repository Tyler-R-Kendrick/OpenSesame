/**
 * J-DURESS-ITEMS: "Decoy with everyday items" (ADR 0168), set from Settings and
 * used where a vault unlocks — in the built app, with nothing mocked.
 *
 * The owner keeps one real item, picks the mode, finds a starter list in the
 * box, edits it and turns the code on. After a reload (an armed code lives in
 * the origin's files and has to survive one) the code opens a decoy that lists
 * exactly the owner's items, none of the real vault's, and none of the tells;
 * the vault's own password then still opens the real vault, with its real item
 * and none of the decoy's.
 */
import { TELLS } from "./j-duress-journey.mjs";
import {
  PASSWORD,
  openSettingsCategory,
  sealWithPassword,
  waitOpen,
} from "./pages-journey.mjs";

const CODE = "246813579";
const REAL_ITEM = "Real bank login";
const MODE = "Decoy with everyday items";
const MINE = [
  "Netflix",
  "Wi-Fi at home",
  "Library card",
  "Gym club",
  "Water bill",
];

const pageText = async (page) =>
  (await page.locator("body").innerText()).replace(/\s+/g, " ");

/** The vault's list, by its route, from wherever the page was left. */
async function toTheVault(page, base) {
  await page.evaluate((href) => {
    history.pushState(null, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}vault`);
  await page.waitForTimeout(1200);
}

/** A list row: the item's name and its type, as the list draws them (`Gym club.login`). */
const row = (page, name) =>
  page
    .getByText(
      new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\w+$`),
    )
    .locator("visible=true");

const visible = (page, name) => row(page, name).count();

async function keepRealItem(page) {
  const create = page.getByRole("link", { name: "New item", exact: true });
  await create.first().waitFor({ timeout: 20000 });
  await create.first().click();
  await page.getByLabel("Name", { exact: true }).fill(REAL_ITEM);
  await page.getByLabel("Secret value", { exact: true }).fill("hunter2-real");
  await page
    .getByRole("button", { name: "Save item", exact: true })
    .first()
    .click();
  await page.waitForTimeout(900);
}

/** Pick the mode, find the starter, edit it, set the code. */
async function turnOn({ page, check, snap }) {
  await openSettingsCategory(page, "Security");
  await page.locator("#duress-profiles").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Add" }).last().click();
  const radios = page.getByRole("radio");
  check(
    (await radios.count()) >= 3 &&
      (await page.getByRole("radio", { name: MODE }).count()) === 1,
    "the sheet offers the everyday-items decoy among at least the three modes it was added to",
  );
  await page.getByRole("radio", { name: MODE }).check();
  const list = page.getByRole("textbox", { name: /Everyday items/ });
  const starter = (await list.inputValue()).split("\n");
  check(
    starter.length >= 3 && starter.every((line) => line.trim().length > 0),
    `picking the mode fills a starter list of ${starter.length} lines to edit`,
  );
  await snap(page, "J-DURESS-ITEMS-starter");

  const fields = page.locator("[role=dialog] input[type=password]");
  await fields.nth(0).fill(CODE);
  await fields.nth(1).fill(CODE);
  const go = page.getByRole("button", { name: "Turn on duress code" });
  check(
    await go.isDisabled(),
    "arming waits for the consent written for this mode",
  );
  await page.getByRole("checkbox").check();
  check(await go.isEnabled(), "with the consent ticked the key is live");
  await list.fill("Netflix\nGym");
  check(await go.isDisabled(), "two lines are too few to arm");
  await list.fill(MINE.join("\n"));
  check(await go.isEnabled(), "the owner's five lines arm");
  await go.click();
  await page.getByText("Duress code is on.").waitFor({ timeout: 20000 });
  await snap(page, "J-DURESS-ITEMS-on");
}

/** Reloaded, the code opens a decoy holding the owner's items, and the tells are absent. */
async function useCode({ page, base, check, snap }) {
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
  await toTheVault(page, base);
  for (const title of MINE) {
    await row(page, title).first().waitFor({ timeout: 15000 });
  }
  const seen = await pageText(page);
  check(
    (await Promise.all(MINE.map((title) => visible(page, title)))).every(
      (count) => count >= 1,
    ),
    `the decoy lists the owner's ${MINE.length} items`,
  );
  check(
    (await visible(page, REAL_ITEM)) === 0 && !seen.includes(REAL_ITEM),
    "the decoy shows nothing of the real vault",
  );
  check(
    TELLS.every((tell) => !tell.test(seen)),
    "the decoy never says guest, decoy, duress, unavailable or locked",
  );
  check(
    (await page.locator(".duress-presentation-overlay").count()) === 0,
    "the decoy draws no presentation overlay",
  );
  await snap(page, "J-DURESS-ITEMS-decoy");
}

/** The vault's own password still opens the real vault, whole, without the decoy's items. */
async function comeBack({ page, base, check, snap }) {
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .click();
  await page
    .getByLabel("Password", { exact: true })
    .waitFor({ timeout: 15000 });
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
  await toTheVault(page, base);
  await row(page, REAL_ITEM).first().waitFor({ timeout: 15000 });
  check(true, "the vault's own password opens the real vault and its item");
  const counts = await Promise.all(MINE.map((title) => visible(page, title)));
  check(
    counts.every((count) => count === 0),
    "none of the decoy's items reached the real vault",
  );
  await snap(page, "J-DURESS-ITEMS-real");
}

export async function walkJDuressItems(context) {
  const { page, origin, base } = context;
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await keepRealItem(page);
  await turnOn(context);
  await useCode(context);
  await comeBack(context);
}
