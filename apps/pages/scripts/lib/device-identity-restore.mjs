/**
 * The device principal across backup and restore (ADR 0160 §5), in a real
 * browser against the production build: the identity key rides sealed in the
 * vault body, so an offline backup carries it, a restore on another device
 * keeps the principal, a backup without it mints one key and says so, and a
 * vault that meets a second key for itself keeps the older, ending the
 * loser's sessions. Each "device" is its own browser context: its own storage,
 * its own vault, nothing shared but the file the person carries.
 *
 * Driven through the app's own keys (Export items, Import items) and its own
 * device host, imported by URL as `verify:device-identity` already does.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asBearer, hostCall, mintInit } from "./device-identity-scenarios.mjs";
import { passTheDoor } from "./front-door.mjs";
import { PASSWORD, sealLocalOnly } from "./pages-journey.mjs";

const env = {};

/** The harness of this run (check, setStep, newPage, ORIGIN, BASE). */
export function configureRestore(next) {
  Object.assign(env, next);
}

const PRINCIPAL = /^prn_[A-Za-z0-9_-]{43}$/;

/** A new device: its own context, a fresh vault sealed with the password. */
async function newDevice(browser) {
  const { page, context } = await env.newPage(browser);
  await page.goto(`${env.ORIGIN}${env.BASE}`, { waitUntil: "networkidle" });
  await passTheDoor(page);
  await sealLocalOnly(page);
  return { page, context };
}

async function connect(page) {
  const res = await hostCall(page, "/v1/principals/provisional", mintInit);
  return { principalId: res.body.principalId, token: res.body.accessToken };
}

async function stands(page, session) {
  const res = await hostCall(
    page,
    "/v1/principals/me",
    asBearer(session.token),
  );
  return res.status === 200 && res.body.id === session.principalId;
}

async function ended(page, session) {
  const res = await hostCall(
    page,
    "/v1/principals/me",
    asBearer(session.token),
  );
  return res.status === 401;
}

/** The Export key: one encrypted backup file, saved where the test says. */
async function exportBackup(page, file) {
  await page
    .getByRole("button", { name: "Export items" })
    .locator("visible=true")
    .first()
    .click();
  const sheet = page.getByRole("dialog", { name: "Export encrypted vault" });
  await sheet.waitFor({ timeout: 15000 });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    sheet.getByRole("button", { name: "Save backup" }).click(),
  ]);
  await download.saveAs(file);
  await sheet.getByRole("button", { name: "Close" }).first().click();
  await sheet.waitFor({ state: "detached", timeout: 10000 });
}

const TAKE = "Also take its device identity";

/**
 * The Import key, then the restore card with the backup's own password. The
 * backup's device identity is taken only when `take` is set: the card offers
 * the choice to a vault that has done nothing yet and leaves it off.
 */
async function restoreBackup(page, file, { take = false } = {}) {
  await page.getByLabel("Choose a file to import").first().setInputFiles(file);
  const sheet = page.getByRole("dialog", { name: "Import items" });
  await sheet.waitFor({ timeout: 15000 });
  await sheet.getByLabel("Master password", { exact: true }).fill(PASSWORD);
  if (take) await sheet.getByRole("checkbox", { name: TAKE }).check();
  await sheet.getByRole("button", { name: "Restore items" }).click();
  await sheet
    .getByText("Restored", { exact: true })
    .waitFor({ timeout: 30000 });
  await sheet.getByRole("button", { name: "Close" }).first().click();
  await sheet.waitFor({ state: "detached", timeout: 10000 });
}

/** Does the notifications bell say `title`? Falls back to the page's text. */
async function bellSays(page, title) {
  const bell = page
    .getByRole("button", { name: /^Notifications — / })
    .locator("visible=true")
    .first();
  if ((await bell.count()) === 0) {
    return (await page.evaluate(() => document.body.innerText)).includes(title);
  }
  await bell.click();
  const sheet = page.getByRole("dialog", { name: "Notifications" });
  await sheet.waitFor({ timeout: 10000 });
  const said = (await sheet.innerText()).includes(title);
  await sheet.getByRole("button", { name: "Close" }).first().click();
  await sheet.waitFor({ state: "detached", timeout: 10000 });
  return said;
}

function tmp(name) {
  return path.join(os.tmpdir(), `device-identity-${process.pid}-${name}.json`);
}

/** Export, wipe (a new device), restore: the same principal. */
export async function restoredElsewhere(browser) {
  const label = "restore";
  env.setStep(label);
  const files = [];
  const source = await newDevice(browser);
  const original = await connect(source.page);
  env.check(
    PRINCIPAL.test(original.principalId),
    `${label}: the source vault's principal is prn_ + a thumbprint`,
  );
  const backup = tmp("backup");
  files.push(backup);
  await exportBackup(source.page, backup);
  const text = fs.readFileSync(backup, "utf8");
  const thumbprint = original.principalId.slice("prn_".length);
  env.check(
    !text.includes(thumbprint) && !text.includes("privateJwkJson"),
    `${label}: the backup file shows nothing of the key in the clear`,
  );
  env.check(
    (await stands(source.page, original)) === true,
    `${label}: exporting leaves the source session standing`,
  );

  // Another device: a fresh vault that has never held a key, then the file.
  const elsewhere = await newDevice(browser);
  await restoreBackup(elsewhere.page, backup, { take: true });
  const restored = await connect(elsewhere.page);
  env.check(
    restored.principalId === original.principalId,
    `${label}: restored on another device with its identity taken, the principal is the same`,
  );
  env.check(
    !(await bellSays(elsewhere.page, "Device identity changed")),
    `${label}: nothing is announced when no key was lost`,
  );

  // A device whose fresh vault already minted its own key takes the backup's.
  const minted = await newDevice(browser);
  const before = await connect(minted.page);
  env.check(
    before.principalId !== original.principalId,
    `${label}: a fresh vault's own key is another principal`,
  );
  await restoreBackup(minted.page, backup, { take: true });
  env.check(
    await ended(minted.page, before),
    `${label}: the key that lost ends its sessions`,
  );
  env.check(
    (await connect(minted.page)).principalId === original.principalId,
    `${label}: the restored vault is the backup's principal`,
  );
  env.check(
    await bellSays(minted.page, "Device identity changed"),
    `${label}: the bell says the principal changed`,
  );
  await Promise.all(
    [source, elsewhere, minted].map(({ context }) => context.close()),
  );
  for (const file of files) fs.rmSync(file, { force: true });
}

/** A backup that carries no key mints one, once, and says so. */
export async function restoredWithoutKey(browser) {
  const label = "keyless";
  env.setStep(label);
  const source = await newDevice(browser);
  // Exported before any session, so the body holds no key (a backup from
  // before keys travelled looks the same).
  const backup = tmp("keyless");
  await exportBackup(source.page, backup);
  const target = await newDevice(browser);
  await restoreBackup(target.page, backup, { take: true });
  const first = await connect(target.page);
  const second = await connect(target.page);
  env.check(
    PRINCIPAL.test(first.principalId) &&
      first.principalId === second.principalId,
    `${label}: one key is minted, once, and every session is that principal`,
  );
  env.check(
    await bellSays(target.page, "Restored without an identity key"),
    `${label}: the bell says it was restored without a key`,
  );
  // And from now on it travels.
  const next = tmp("keyless-next");
  await exportBackup(target.page, next);
  const again = await newDevice(browser);
  await restoreBackup(again.page, next, { take: true });
  env.check(
    (await connect(again.page)).principalId === first.principalId,
    `${label}: the minted key travels with the next backup`,
  );
  await Promise.all(
    [source, target, again].map(({ context }) => context.close()),
  );
  fs.rmSync(backup, { force: true });
  fs.rmSync(next, { force: true });
}

/**
 * A restore never takes the backup's identity unless the person chose it: a
 * fresh vault that restores a backup carrying another key keeps its own
 * principal, says nothing, and the choice is there, off, on the card.
 */
export async function restoreDeclined(browser) {
  const label = "declined";
  env.setStep(label);
  const source = await newDevice(browser);
  await connect(source.page);
  const backup = tmp("declined");
  await exportBackup(source.page, backup);

  const target = await newDevice(browser);
  const own = await connect(target.page);
  await target.page
    .getByLabel("Choose a file to import")
    .first()
    .setInputFiles(backup);
  const sheet = target.page.getByRole("dialog", { name: "Import items" });
  await sheet.waitFor({ timeout: 15000 });
  const box = sheet.getByRole("checkbox", { name: TAKE });
  env.check(
    (await box.count()) === 1 && !(await box.isChecked()),
    `${label}: a fresh vault is offered the backup's identity, off`,
  );
  await sheet.getByLabel("Master password", { exact: true }).fill(PASSWORD);
  await sheet.getByRole("button", { name: "Restore items" }).click();
  await sheet
    .getByText("Restored", { exact: true })
    .waitFor({ timeout: 30000 });
  await sheet.getByRole("button", { name: "Close" }).first().click();
  await sheet.waitFor({ state: "detached", timeout: 10000 });
  env.check(
    await stands(target.page, own),
    `${label}: declined, the vault keeps its principal and its session stands`,
  );
  env.check(
    !(await bellSays(target.page, "Device identity changed")),
    `${label}: nothing is announced`,
  );
  await Promise.all([source, target].map(({ context }) => context.close()));
  fs.rmSync(backup, { force: true });
}
