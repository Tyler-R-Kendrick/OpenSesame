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

/** The Import key, then the restore card with the backup's own password. */
async function restoreBackup(page, file) {
  await page.getByLabel("Choose a file to import").setInputFiles(file);
  const sheet = page.getByRole("dialog", { name: "Import items" });
  await sheet.waitFor({ timeout: 15000 });
  await sheet.getByLabel("Master password", { exact: true }).fill(PASSWORD);
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
  await restoreBackup(elsewhere.page, backup);
  const restored = await connect(elsewhere.page);
  env.check(
    restored.principalId === original.principalId,
    `${label}: restored on another device, the principal is the same`,
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
  await restoreBackup(minted.page, backup);
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
  await restoreBackup(target.page, backup);
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
  await restoreBackup(again.page, next);
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
 * A vault that meets a second key for itself keeps the older, whichever is
 * restored last, and the loser's sessions end. The second key is another
 * vault's, taken in by a vault that had done nothing yet (the restore case),
 * then the vault's own backup is restored into it.
 */
export async function olderKeyWins(browser) {
  const label = "conflict";
  env.setStep(label);
  const one = await newDevice(browser);
  const oldKey = await connect(one.page);
  const backupOne = tmp("one");
  await exportBackup(one.page, backupOne);

  // A later vault elsewhere, with a later key.
  const two = await newDevice(browser);
  const newKey = await connect(two.page);
  const backupTwo = tmp("two");
  await exportBackup(two.page, backupTwo);
  env.check(
    oldKey.principalId !== newKey.principalId,
    `${label}: two vaults, two keys`,
  );

  // The first vault, unused beyond its key, restores the later vault's backup:
  // it takes that principal (a restore of someone's identity, not a ranking).
  await restoreBackup(one.page, backupTwo);
  env.check(
    await ended(one.page, oldKey),
    `${label}: the vault's own key gave way to the restored one`,
  );
  const adopted = await connect(one.page);
  env.check(
    adopted.principalId === newKey.principalId,
    `${label}: it now speaks as the restored principal`,
  );

  // Now its own backup comes back: the same vault, two keys. The older wins.
  await restoreBackup(one.page, backupOne);
  env.check(
    await ended(one.page, adopted),
    `${label}: the newer key's session ends`,
  );
  const settled = await connect(one.page);
  env.check(
    settled.principalId === oldKey.principalId,
    `${label}: the older key is the vault's again`,
  );
  env.check(
    await bellSays(one.page, "Device identity changed"),
    `${label}: the bell says the principal changed`,
  );
  await Promise.all([one, two].map(({ context }) => context.close()));
  fs.rmSync(backupOne, { force: true });
  fs.rmSync(backupTwo, { force: true });
}
