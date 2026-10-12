/**
 * J-TRAVEL-ITEMS: leaving items at home, from Settings › Security › Travel
 * (ADR 0171) — in the built app, real storage, real crypto, a real bundle file.
 *
 * A vault of several items. Two are chosen to stay home, packed, saved and
 * taken out. After a reload, a lock and an unlock with the real key — the
 * compelled unlock at a border — their titles and secrets appear nowhere on
 * any vault screen: not the list, not a search for them, not the trash, not
 * the activity history, not the Travel panel; the page's markup carries none
 * either. A wrong code is refused, the right one brings them back, and they
 * are findable again.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  lockVault,
  openSettingsCategory,
  sealWithPin,
  unlockWithPin,
} from "./pages-journey.mjs";

const HIDE = [
  { name: "Zebra Offshore Bank", secret: "pw-zebra-9f31" },
  { name: "Quartz Escrow Account", secret: "pw-quartz-88e2" },
];
const KEEP = [
  { name: "Keeper One", secret: "pw-keeper-1-ab9c" },
  { name: "Keeper Two", secret: "pw-keeper-2-cd7e" },
];
const TRASHED = { name: "Trashed Memo", secret: "pw-trashed-31f0" };
const NEEDLES = HIDE.flatMap((item) => [item.name, item.secret]);

const text = async (page) =>
  (await page.locator("body").innerText()).replace(/\s+/g, " ");

const leaked = (haystack) =>
  NEEDLES.filter((needle) => haystack.includes(needle));

/** In-app navigation by route: no reload, so the vault stays open. */
async function go(page, base, route) {
  await page.evaluate((href) => {
    history.pushState(null, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
  await page.waitForTimeout(1200);
}

async function addItem(page, { name, secret }) {
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

async function trashFirst(page, base, name) {
  await go(page, base, "vault");
  await page
    .getByText(new RegExp(`^${name}\\.\\w+$`))
    .first()
    .click();
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Really move to trash?", exact: true })
    .first()
    .click();
  await page.waitForTimeout(900);
}

/** A return code with a valid check that opens nothing: the algorithm of lib/travel/return-code. */
function otherCode() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const secret = crypto.randomBytes(18);
  const check = crypto
    .createHash("sha256")
    .update(secret)
    .digest()
    .subarray(0, 2);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of Buffer.concat([secret, check])) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  return out.match(/.{1,4}/g).join("-");
}

async function unlockPersonal(page) {
  // One vault on the device: the unlock form is already up, no list to pick from.
  const pick = page.getByRole("button", { name: /^personal/ });
  if ((await pick.count()) > 0) await pick.first().click();
  await unlockWithPin(page);
}

async function openTravel(page) {
  await openSettingsCategory(page, "Security");
  await page.locator("#travel").waitFor({ timeout: 15000 });
}

/** Choose the two, pack, save the bundle, confirm all three, take them out. */
async function hide({ page, check, snap }) {
  await openTravel(page);
  const before = await page.locator("#travel").innerText();
  check(
    !leaked(before).length && /Leave items at home/.test(before),
    "the Travel panel offers to leave items at home and names none of them",
  );
  await page
    .getByRole("button", { name: "Choose items to leave at home" })
    .click();
  const sheet = page.getByRole("dialog", { name: "Leave items at home" });
  await sheet.waitFor({ timeout: 15000 });
  for (const item of HIDE) {
    await sheet
      .getByRole("switch", { name: `Stays home: ${item.name}` })
      .click();
  }
  await snap(page, "J-TRAVEL-ITEMS-choose");
  await sheet
    .getByRole("button", { name: "Pack the items for travel" })
    .click();
  const code = (await page.locator(".travel__code").innerText()).trim();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    sheet.getByRole("button", { name: "Save the travel bundle" }).click(),
  ]);
  const bundle = path.join(os.tmpdir(), `travel-items-${Date.now()}.json`);
  await download.saveAs(bundle);
  const saved = fs.readFileSync(bundle, "utf8");
  check(
    saved.length > 0 && !leaked(saved).length && !/Zebra|Quartz/.test(saved),
    "the saved bundle names none of the items outside its seal",
  );
  await snap(page, "J-TRAVEL-ITEMS-packed");
  await sheet
    .getByLabel("The bundle is saved somewhere other than this device")
    .check();
  await sheet
    .getByLabel("The return code is written down, and it stays home")
    .check();
  const takeOut = sheet.getByRole("button", {
    name: "Take them out of this vault",
  });
  check(
    await takeOut.isDisabled(),
    "the items cannot leave before the copies elsewhere are acknowledged",
  );
  await sheet
    .getByLabel(/Other devices, exports and backups still hold/)
    .check();
  await takeOut.click();
  await page
    .getByText(/2 items left this vault/)
    .first()
    .waitFor({ timeout: 30000 });
  await snap(page, "J-TRAVEL-ITEMS-hidden");
  return { bundle, code };
}

/** Every vault screen, as a person made to unlock would see it. */
async function surfaces(page, base) {
  const seen = [];
  for (const [label, route] of [
    ["the vault list", "vault"],
    [
      "a search for the first hidden title",
      `vault?q=${encodeURIComponent("Zebra")}`,
    ],
    ["a search for the second", `vault?q=${encodeURIComponent("Quartz")}`],
    ["the trash", "vault?f=trash"],
    ["the activity history", "activity"],
  ]) {
    await go(page, base, route);
    seen.push([label, await text(page), await page.content()]);
  }
  return seen;
}

/** After a reload, a lock and an unlock with the real key. */
async function atTheBorder({ page, check, snap }, base) {
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("PIN", { exact: true }).waitFor({ timeout: 15000 });
  await unlockPersonal(page);
  await lockVault(page);
  await unlockPersonal(page);
  const seen = await surfaces(page, base);
  for (const [label, body, markup] of seen) {
    check(
      leaked(body).length === 0 && leaked(markup).length === 0,
      `${label} shows nothing of the hidden items (${leaked(body).concat(leaked(markup)).join(", ")})`,
    );
  }
  const list = seen[0][1];
  check(
    KEEP.every((item) => list.includes(item.name)),
    "the items that stayed are all there",
  );
  check(
    /Nothing here|No items|0 items/i.test(seen[1][1]) ||
      !HIDE.some((item) => seen[1][1].includes(item.name)),
    "a search for a hidden title finds nothing",
  );
  check(
    seen[3][1].includes(TRASHED.name),
    "the trash still lists what was trashed, and nothing of the hidden",
  );
  await snap(page, "J-TRAVEL-ITEMS-border");
  await openTravel(page);
  const panel = await page.locator("#travel").innerText();
  check(
    leaked(panel).length === 0 && /Come home from a trip/.test(panel),
    "the Travel panel keeps no list of what is away",
  );
}

/** Wrong code refused, the right one brings them back. */
async function comeBack({ page, check, snap }, base, { bundle, code }) {
  await openTravel(page);
  await page.getByRole("button", { name: "Turn off travel mode" }).click();
  const dialog = page.getByRole("dialog", { name: "Turn off travel mode" });
  await dialog.waitFor({ timeout: 15000 });
  await dialog.locator("input[type=file]").setInputFiles(bundle);
  await dialog.locator("#travel-return-code").fill(otherCode());
  await dialog.getByRole("button", { name: "Open the bundle" }).click();
  await page.waitForTimeout(800);
  check(
    (await dialog.getByLabel(/does not open this bundle/).count()) > 0,
    "a wrong return code is refused",
  );
  check(
    (await text(page)).includes("Ready to come back") === false,
    "a wrong code opens no preview",
  );
  await dialog.locator("#travel-return-code").fill(code);
  await dialog.getByRole("button", { name: "Open the bundle" }).click();
  await dialog.getByText("Ready to come back").waitFor({ timeout: 20000 });
  const preview = await dialog.innerText();
  check(
    HIDE.every((item) => preview.includes(item.name)),
    "with the right code the preview names the items",
  );
  await snap(page, "J-TRAVEL-ITEMS-preview");
  await dialog.getByRole("button", { name: "Bring them back" }).click();
  await page
    .getByText(/2 items came back/)
    .first()
    .waitFor({ timeout: 30000 });
  await go(page, base, "vault");
  const list = await text(page);
  check(
    HIDE.every((item) => list.includes(item.name)),
    "the items are back in the list",
  );
  await go(page, base, `vault?q=${encodeURIComponent("Zebra")}`);
  check(
    (await text(page)).includes("Zebra Offshore Bank"),
    "a search for a returned title finds it again",
  );
  await snap(page, "J-TRAVEL-ITEMS-back");
  fs.rmSync(bundle, { force: true });
}

export async function walkJTravelItems(context) {
  const { page, origin, base } = context;
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  for (const item of [...HIDE, ...KEEP, TRASHED]) await addItem(page, item);
  await trashFirst(page, base, TRASHED.name);
  // Before: the history does carry them, so the walk has something to find.
  await go(page, base, "activity");
  context.check(
    HIDE.every((item) => true) &&
      (await text(page)).includes("Zebra Offshore Bank"),
    "before hiding, the activity history names the item (so the later absence means something)",
  );
  const trip = await hide(context);
  await atTheBorder(context, base);
  await comeBack(context, base, trip);
}
