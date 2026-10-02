/**
 * J-TRAVEL: travel mode from Settings › Security, end to end (ADR 0143, 0150)
 * — in the built app, real storage, a real bundle file.
 *
 * Two extra vaults, one marked safe. The mark survives a reload. The rest
 * are packed, saved, taken off the device (gone from the unlock list after a
 * reload), then brought home from the saved bundle and its return code.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PASSWORD,
  openSettingsCategory,
  sealWithPassword,
  waitOpen,
} from "./pages-journey.mjs";

const panel = async (page) =>
  (await page.locator("#travel").innerText()).replace(/\s+/g, " ");

async function openPersonal(page) {
  await page.getByRole("button", { name: /^personal/ }).click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
  await openSettingsCategory(page, "Security");
  await page.locator("#travel").waitFor({ timeout: 15000 });
}

const safeSwitch = (page, name) =>
  page.getByRole("switch", { name: `Safe for travel: ${name}` });

/** Seal a named vault with this vault's key, then return to personal. */
async function sealNamed(page, name) {
  await page.getByRole("button", { name: "Seal a new vault" }).click();
  const dialog = page.getByRole("dialog", { name: "Seal a new vault" });
  await dialog.waitFor({ timeout: 15000 });
  await dialog.locator("#vaults-new-name").fill(name);
  await dialog.getByRole("button", { name: "Seal vault" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 20000 });
  // Sealing shares the open key and lands in the new vault. Personal has to
  // be the open one: an open vault always travels, so it cannot be the one
  // this walk sends home.
  const personal = page.getByRole("button", { name: /^personal/ });
  if ((await personal.count()) > 0) {
    await personal.first().click();
    await waitOpen(page);
    await openSettingsCategory(page, "Vaults");
  }
}

async function openLeave(page) {
  // Travel draws beside Duress, on Security, once a vault is open.
  await openSettingsCategory(page, "Security");
  await page.locator("#travel").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Turn on travel mode" }).click();
  await page
    .getByRole("dialog", { name: "Turn on travel mode" })
    .waitFor({ timeout: 15000 });
}

/** Two extra vaults, one marked safe, and the mark kept across a reload. */
async function markSafe({ page, check, snap }) {
  for (const name of ["Work", "Trip"]) {
    await sealNamed(page, name);
  }
  await openLeave(page);
  const marked = safeSwitch(page, "Work");
  await marked.waitFor({ timeout: 20000 });
  if ((await marked.getAttribute("aria-checked")) !== "true") {
    await marked.click();
  }
  // The mark is written to the origin's files; let the write land before the reload.
  await page.waitForTimeout(1500);
  check(
    (await marked.getAttribute("aria-checked")) === "true",
    "a vault can be marked safe for travel",
  );
  await page.reload({ waitUntil: "networkidle" });
  await openPersonal(page);
  await openLeave(page);
  check(
    (await safeSwitch(page, "Work").getAttribute("aria-checked")) === "true",
    "the safe mark survives a reload",
  );
  await snap(page, "J-TRAVEL-plan");
}

/** Pack, save the bundle, confirm both, and take the rest off the device. */
async function depart({ page, check, snap }) {
  await page.getByRole("button", { name: "Pack the rest for travel" }).click();
  const code = (await page.locator(".travel__code").innerText()).trim();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save the travel bundle" }).click(),
  ]);
  const bundle = path.join(os.tmpdir(), `travel-${Date.now()}.json`);
  await download.saveAs(bundle);
  check(fs.statSync(bundle).size > 0, "the travel bundle was saved");
  await page
    .getByLabel("The bundle is saved somewhere other than this device")
    .check();
  await page
    .getByLabel("The return code is written down, and it stays home")
    .check();
  await page.getByRole("button", { name: "Take them off this device" }).click();
  await page
    .getByText(/left this device/)
    .first()
    .waitFor({ timeout: 30000 });
  check(
    /1 vault left this device/.test(await panel(page)),
    "the vault that was not marked safe left this device",
  );
  check(
    (await page.getByRole("button", { name: /Trip/ }).count()) === 0,
    "the vault that left is no longer listed",
  );
  await snap(page, "J-TRAVEL-departed");
  return { bundle, code };
}

/** After a reload the unlock list keeps the safe vault and not the one that left. */
async function gone({ page, check }) {
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^personal/ }).waitFor({
    timeout: 15000,
  });
  // Before unlock a project's name stays inside the tomb (ADR 0089), so the
  // vault that stayed is one sealed project row. "Work" is visible only once
  // this device is open again.
  const offered = (await page.getByRole("button").allTextContents())
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter((text) => /personal|Work|Trip|project ·/.test(text));
  const stayed = offered.filter(
    (text) =>
      /project · [0-9a-f]{4}/.test(text) &&
      /name is inside the vault/.test(text),
  );
  check(
    stayed.length === 1,
    `the vault marked safe is still on the device (${offered.join(" | ")})`,
  );
  check(
    offered.length === 2 && offered.every((text) => !/Trip/.test(text)),
    "only the vault marked safe is still on the device",
  );
  await openPersonal(page);
  const open = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check(
    /Work/.test(open),
    "the safe vault's name is on this device once it is open",
  );
  check(
    !/project · [0-9a-f]{4}/.test(open),
    "the vault that left is still gone after unlock",
  );
}

/** Home again from the bundle file and the return code. */
async function comeHome({ page, check, snap }, { bundle, code }) {
  await page.getByRole("button", { name: "Turn off travel mode" }).click();
  const dialog = page.getByRole("dialog", { name: "Turn off travel mode" });
  await dialog.waitFor({ timeout: 15000 });
  await dialog.locator("input[type=file]").setInputFiles(bundle);
  await dialog.locator("#travel-return-code").fill(code);
  await dialog.getByRole("button", { name: "Open the bundle" }).click();
  await dialog.getByRole("button", { name: "Bring them home" }).click();
  await page.getByText("1 vault came home").waitFor({ timeout: 30000 });
  const home = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check(
    /3 vaults on this device/.test(home) &&
      (/Trip/.test(home) || /project · [0-9a-f]{4}/.test(home)),
    "the vault that left is back, its name sealed until it is opened",
  );
  await snap(page, "J-TRAVEL-home");
  fs.rmSync(bundle, { force: true });
}

export async function walkJTravel(context) {
  const { page, origin, base } = context;
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await openSettingsCategory(page, "Vaults");
  await markSafe(context);
  const trip = await depart(context);
  await gone(context);
  await comeHome(context, trip);
}
