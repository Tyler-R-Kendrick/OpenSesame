/**
 * J-DURESS-VISIBLE: "Show my vault without the items I hide" (ADR 0168), set
 * from Settings and used where a vault unlocks — in the built app, with
 * nothing mocked.
 *
 * The owner keeps four items, opens the mode and finds the four listed as
 * switches, every one hidden. They leave two shown, turn the code on, and the
 * page is reloaded (an armed code lives in the origin's files). Typed at the
 * unlock screen after the reload, the code opens a decoy that lists exactly the
 * two shown items and none of the hidden ones: not a name, not a secret, not
 * in the page text or anywhere in the document. The guest road is still on the
 * unlock screen, the tells are absent, and the vault's own password then opens
 * the real vault with all four.
 */
import { TELLS } from "./j-duress-journey.mjs";
import {
  PIN,
  openSettingsCategory,
  sealWithPin,
  waitOpen,
} from "./pages-journey.mjs";

const CODE = "246813579";
const MODE = "Show my vault without the items I hide";

/** Distinct strings, so a leak is a substring and never a coincidence. */
const SHOWN = [
  { name: "Streaming account", secret: "shown-secret-4417" },
  { name: "Gym locker", secret: "shown-secret-6612" },
];
const HIDDEN = [
  { name: "Hidden Bank 7731", secret: "hidden-secret-7731" },
  { name: "Hidden Passport 5520", secret: "hidden-secret-5520" },
];
const ALL = [HIDDEN[0], SHOWN[0], HIDDEN[1], SHOWN[1]];

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

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A list row: the item's name and its type, as the list draws them (`Gym locker.secret`). */
const row = (page, name) =>
  page
    .getByText(new RegExp(`^${escapeRe(name)}\\.\\w+$`))
    .locator("visible=true");

const visible = (page, name) => row(page, name).count();

async function keepItem(page, { name, secret }) {
  const create = page.getByRole("link", { name: "New item", exact: true });
  await create.first().waitFor({ timeout: 20000 });
  await create.first().click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Secret value", { exact: true }).fill(secret);
  await page
    .getByRole("button", { name: "Save item", exact: true })
    .first()
    .click();
  await page.waitForTimeout(900);
}

/** Open the mode, find every item hidden, leave two shown, set the code. */
async function turnOn({ page, check, snap }) {
  await openSettingsCategory(page, "Security");
  await page.locator("#duress-profiles").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Add" }).last().click();
  const radios = await page
    .getByRole("radio")
    .evaluateAll((nodes) => nodes.map((n) => n.closest("label")?.innerText));
  check(
    radios.indexOf(MODE) > radios.indexOf("Decoy vault") &&
      radios.indexOf(MODE) < radios.indexOf("Wrong password") &&
      radios.indexOf(MODE) < radios.indexOf("Freeze for a while") &&
      radios.indexOf(MODE) < radios.indexOf("Wipe this device's copy"),
    "the mode comes after the plain decoy and before every refusal",
  );
  await page.getByRole("radio", { name: MODE }).check();

  const switches = page.getByRole("switch");
  check(
    (await switches.count()) === ALL.length,
    `the sheet lists the vault's ${ALL.length} items as switches`,
  );
  const states = await switches.evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("aria-checked")),
  );
  check(
    states.every((state) => state === "true"),
    "every item starts hidden",
  );
  const sheet = await page.locator("[role=dialog]").innerText();
  check(
    ALL.every((item) => !sheet.includes(item.secret)),
    "the list shows names and kinds, never a secret",
  );
  await snap(page, "J-DURESS-VISIBLE-all-hidden");

  const fields = page.locator("[role=dialog] input[type=password]");
  await fields.nth(0).fill(CODE);
  await fields.nth(1).fill(CODE);
  const go = page.getByRole("button", { name: "Turn on duress code" });
  await page.getByRole("checkbox").check();
  check(
    await go.isDisabled(),
    "with everything hidden there is nothing to show, so the key stays off",
  );
  for (const item of SHOWN) {
    await page.getByRole("switch", { name: `Hide ${item.name}` }).click();
  }
  const after = await switches.evaluateAll((nodes) =>
    nodes.map((n) => [
      n.getAttribute("aria-label"),
      n.getAttribute("aria-checked"),
    ]),
  );
  check(
    after.every(
      ([label, state]) =>
        state ===
        (SHOWN.some((i) => label === `Hide ${i.name}`) ? "false" : "true"),
    ),
    "switching Hidden off on two items leaves exactly those two shown",
  );
  check(await go.isEnabled(), "with two items shown the key is live");
  await snap(page, "J-DURESS-VISIBLE-two-shown");
  await go.click();
  await page.getByText("Duress code is on.").waitFor({ timeout: 30000 });
  await snap(page, "J-DURESS-VISIBLE-on");
}

/** Reloaded, the code opens a decoy holding the two shown items and nothing else. */
async function useCode({ page, base, check, snap }) {
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("PIN", { exact: true }).waitFor({ timeout: 15000 });
  check(
    (await page.getByText("Skip to the guest vault").count()) >= 1,
    "the guest road is still on the unlock screen",
  );
  await page.getByLabel("PIN", { exact: true }).fill(CODE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page).catch(async (error) => {
    const body = await page.evaluate(() => document.body.innerText);
    throw new Error(
      `the code did not open the decoy after a reload: ${body.slice(0, 300)} (${error.message})`,
    );
  });
  await toTheVault(page, base);
  for (const item of SHOWN) {
    await row(page, item.name).first().waitFor({ timeout: 15000 });
  }
  const seen = await pageText(page);
  const html = await page.content();
  check(
    (await Promise.all(SHOWN.map((item) => visible(page, item.name)))).every(
      (count) => count === 1,
    ),
    "the decoy lists each shown item once",
  );
  check(
    (await Promise.all(HIDDEN.map((item) => visible(page, item.name)))).every(
      (count) => count === 0,
    ),
    "no hidden item is listed",
  );
  check(
    HIDDEN.every(
      (item) =>
        !seen.includes(item.name) &&
        !html.includes(item.name) &&
        !html.includes(item.secret),
    ),
    "no hidden title or secret appears in the page text or anywhere in the document",
  );
  check(
    TELLS.every((tell) => !tell.test(seen)),
    "the decoy never says guest, decoy, duress, unavailable or locked",
  );
  check(
    (await page.locator(".duress-presentation-overlay").count()) === 0,
    "the decoy draws no presentation overlay",
  );
  // The copy opens, and carries the value the owner kept.
  await row(page, SHOWN[0].name).first().click();
  await page
    .getByRole("button", { name: /Reveal/ })
    .first()
    .click({ timeout: 15000 });
  await page
    .getByText(SHOWN[0].secret, { exact: true })
    .waitFor({ timeout: 15000 });
  check(true, "a shown item opens with the value the owner kept");
  await toTheVault(page, base);
  await snap(page, "J-DURESS-VISIBLE-decoy");
}

/** The vault's own password still opens the real vault, whole. */
async function comeBack({ page, base, check, snap }) {
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .click();
  await page.getByLabel("PIN", { exact: true }).waitFor({ timeout: 15000 });
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
  await toTheVault(page, base);
  for (const item of ALL) {
    await row(page, item.name).first().waitFor({ timeout: 15000 });
  }
  const counts = await Promise.all(ALL.map((item) => visible(page, item.name)));
  check(
    counts.every((count) => count === 1),
    "the vault's own password opens the real vault with all four items, none doubled",
  );
  await snap(page, "J-DURESS-VISIBLE-real");
}

export async function walkJDuressVisible(context) {
  const { page, origin, base } = context;
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  for (const item of ALL) await keepItem(page, item);
  await turnOn(context);
  await useCode(context);
  await comeBack(context);
}
