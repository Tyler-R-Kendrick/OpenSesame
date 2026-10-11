// A vault that begins from a file (ADR 0188), on the production origin: the
// front door's third road holds a backup or a `.env` file while the vault is
// sealed, and the Import sheet opens on it by itself once the vault is open.
// Real file chooser, real seal, real WebCrypto — and the proof that matters:
// a PIN-sealed backup written by one vault is opened by its own PIN in
// another, sealed under a different PIN, and the wrong PIN opens nothing.

import fs from "node:fs";
import path from "node:path";
import { checkNothingInTheClear } from "./at-rest-contract.mjs";
import { PIN, sealWithPin, waitOpen } from "./pages-journey.mjs";

/** A second PIN, so a restore that "worked" could not be the same key twice. */
const TARGET_PIN = "13579246";
const CANARY = { name: "Backup canary", secret: "s3cr3t-canary-value" };
const ENV = { API_KEY: "sk-first-run-123", OTHER_TOKEN: "abc-first-run-456" };
const WRONG_PIN_MESSAGE = "That credential did not unlock the vault.";

async function addSecret(page, { name, secret }) {
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

/** A backup the Export key writes, from a vault sealed with `PIN`. */
async function exportBackup(h, browser, ORIGIN, BASE, out) {
  const { page, context } = await h.newPage(browser);
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  await addSecret(page, CANARY);
  await page.getByRole("button", { name: "Export" }).first().click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Save backup|Save again/ }).click(),
  ]);
  const file = path.join(out, "first-run-backup.json");
  await download.saveAs(file);
  await context.close();
  return { name: download.suggestedFilename(), text: fs.readFileSync(file) };
}

/** On the door, or on sign-in: choose `file` and land on the seal screen. */
async function chooseFile(page, check, file, what) {
  await page.getByLabel("Choose a file to import").setInputFiles({
    name: file.name,
    mimeType: file.mimeType ?? "application/octet-stream",
    buffer: file.buffer ?? file.text,
  });
  await page
    .getByRole("heading", { level: 1, name: "Seal this device" })
    .waitFor({ timeout: 15000 });
  check(
    (await page.getByText(file.name, { exact: true }).count()) === 1,
    `${what}: the seal screen names the file it is holding`,
  );
  check(
    (await page.getByRole("button", { name: "Sign in instead" }).count()) === 0,
    `${what}: a vault with a file waiting is sealed here, not signed in to`,
  );
}

async function sealAt(page, pin) {
  await page.getByRole("tab", { name: "PIN" }).click();
  await page.getByLabel("Device PIN", { exact: true }).fill(pin);
  await page.getByLabel("Confirm PIN", { exact: true }).fill(pin);
  await page
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  await page.getByRole("button", { name: "Seal with PIN" }).click();
  await waitOpen(page);
}

const importSheet = (page) =>
  page.getByRole("dialog", { name: "Import items" });

/** The sheet the held file opens, with no Import key pressed. */
async function sheetOpensByItself(page, check, what) {
  await importSheet(page).waitFor({ timeout: 20000 });
  check(true, `${what}: the Import sheet opened on the file by itself`);
}

async function closeAndRead(page, sheet) {
  await sheet.getByRole("button", { name: "Done" }).click();
  await page.waitForTimeout(600);
  return page.locator("body").innerText();
}

/** A fresh device at the front door, with the road in view. */
async function openDoor(ctx) {
  const { h, browser, ORIGIN, BASE } = ctx;
  const { page, context } = await h.newPage(browser);
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Import a file", exact: true })
    .waitFor({ timeout: 15000 });
  return { page, context };
}

/** The backup's own PIN opens it; a well-formed PIN that is not its own opens nothing. */
async function restoreWithPins(page, check, snap) {
  const sheet = importSheet(page);
  await sheet.getByText("the PIN", { exact: true }).waitFor();
  check(true, "backup: the sheet says the backup opens with its PIN");
  await snap(page, "F1-restore-card");

  await sheet.getByLabel("PIN", { exact: true }).fill(TARGET_PIN);
  await sheet.getByRole("button", { name: "Restore items" }).click();
  await sheet
    .getByRole("img", { name: WRONG_PIN_MESSAGE })
    .waitFor({ timeout: 15000 });
  check(true, "backup: a PIN that is not the backup's is refused");
  check(
    (await sheet.getByLabel("PIN", { exact: true }).inputValue()) === "",
    "backup: the refused PIN is emptied from the field",
  );

  await sheet.getByLabel("PIN", { exact: true }).fill(PIN);
  await sheet.getByRole("button", { name: "Restore items" }).click();
  await sheet
    .getByText("Restored", { exact: true })
    .waitFor({ timeout: 20000 });
  await snap(page, "F1-restored");
  return closeAndRead(page, sheet);
}

/** F1: an OpenSesame backup, opened by its own PIN in a new vault. */
async function walkBackup(ctx) {
  const { h, browser, ORIGIN, BASE, OUT } = ctx;
  const { check, setStep, snap } = h;
  setStep("F1-backup");
  const backup = await exportBackup(h, browser, ORIGIN, BASE, OUT);
  check(
    !backup.text.includes(CANARY.secret) && !backup.text.includes(CANARY.name),
    "the backup holds ciphertext only",
  );
  const { page, context } = await openDoor(ctx);
  await chooseFile(page, check, backup, "backup");
  await snap(page, "F1-seal-holding-backup");
  await sealAt(page, TARGET_PIN);
  await sheetOpensByItself(page, check, "backup");
  const vault = await restoreWithPins(page, check, snap);
  check(
    vault.includes(`${CANARY.name}.secret`),
    "backup: the item sealed in the other vault is here, opened by its own PIN",
  );
  setStep("F1-at-rest");
  await checkNothingInTheClear(page, check, [CANARY.secret, CANARY.name]);
  await context.close();
}

/** F2: a .env file, from the door. */
async function walkEnv(ctx) {
  const { check, setStep, snap } = ctx.h;
  setStep("F2-env");
  const { page, context } = await openDoor(ctx);
  const text = Object.entries(ENV)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await chooseFile(
    page,
    check,
    { name: "app.env", mimeType: "text/plain", buffer: Buffer.from(text) },
    "env",
  );
  await sealAt(page, TARGET_PIN);
  await sheetOpensByItself(page, check, "env");
  const sheet = importSheet(page);
  const commit = sheet.getByRole("button", { name: /^Import 2 items/ });
  await commit.waitFor({ timeout: 15000 });
  await snap(page, "F2-env-preview");
  await commit.click();
  await sheet
    .getByText("Imported", { exact: true })
    .waitFor({ timeout: 20000 });
  const vault = await closeAndRead(page, sheet);
  check(
    Object.keys(ENV).every((key) => vault.includes(`${key}.secret`)),
    "env: every key of the .env file is a secret in the new vault",
  );
  setStep("F2-at-rest");
  await checkNothingInTheClear(page, check, Object.values(ENV));
  await context.close();
}

/** F3: changing one's mind gives the door back. */
async function walkRemove(ctx) {
  const { check, setStep } = ctx.h;
  setStep("F3-remove");
  const { page, context } = await openDoor(ctx);
  await chooseFile(
    page,
    check,
    { name: "app.env", mimeType: "text/plain", buffer: Buffer.from("A=1\n") },
    "remove",
  );
  await page.getByRole("button", { name: "Remove file" }).click();
  await page
    .getByRole("heading", { level: 1, name: "open-sesame", exact: true })
    .waitFor({ timeout: 15000 });
  const roads = await page
    .getByRole("button", { name: /^(Set up your own|Import a file)$/ })
    .count();
  check(roads === 2, "remove: the door is back, with every road on it");
  await context.close();
}

export async function walkFirstRunImport(ctx) {
  await walkBackup(ctx);
  await walkEnv(ctx);
  await walkRemove(ctx);
}
