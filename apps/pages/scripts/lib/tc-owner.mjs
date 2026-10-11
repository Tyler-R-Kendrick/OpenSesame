/**
 * What the owner does in Settings › Trusted contacts › Circles, key by key:
 * something to protect, a circle begun, contacts added from their answers, the
 * rule, the clocks, the circle made, and the packets handed out and taken
 * back as receipts.
 */

import fs from "node:fs";
import { expect } from "./tc-expect.mjs";

export const CIRCLE_DIALOG = "Start a circle";

/** Move the app to a route the way its own links do: the SPA's history. */
export async function visit(page, route) {
  await page.evaluate((target) => {
    history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/OpenSesame/${route}`);
}

/** One secret in the vault, made through New item: what the circle will protect. */
export async function createItem(owner, { name, secret }) {
  const { page } = owner;
  await visit(page, "vault/new/secret");
  await owner.type("Name", name, page.locator("form.editor"));
  await page.locator("#secret-value").fill(secret);
  await owner.key("Save item").first().click();
  await expect(page.locator("form.editor")).toHaveCount(0);
}

/** The circle's sheet: opened by the head key, closed by its own. */
export async function openNewCircle(owner) {
  await owner.press("Start a circle");
  const sheet = owner.sheet(CIRCLE_DIALOG);
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Name the circle, press Enter, and take the invitation the step offers. */
export async function nameCircle(owner, sheet, name, { protects } = {}) {
  if (protects) await owner.press(protects, sheet);
  await owner.type("Name", name, sheet);
  await owner.page.keyboard.press("Enter");
  await expect(owner.key("Copy invitation", sheet)).toBeVisible();
  await expect(owner.mark("Invitation QR code", sheet)).toBeVisible();
  return owner.copy("invitation", sheet);
}

/** A contact's answer pasted, read for what it is, and added by its key. */
export async function addContact(owner, sheet, { enrollment, name }) {
  const field = await owner.paste("A contact's answer", enrollment, sheet);
  await expect(sheet.locator(".tc-fact")).toContainText(name);
  await owner.press("Add this contact", sheet);
  await expect(owner.mark(`${name} has answered`, sheet)).toBeVisible();
  await expect(field).toHaveValue("");
}

/** The rule: how many of the contacts it takes. */
export async function setRule(owner, sheet, { needed }) {
  await owner.press("Set the rule", sheet);
  const form = sheet.getByRole("form", { name: "Set the rule" });
  await expect(form).toBeVisible();
  await owner.type("Needed", String(needed), form);
  await owner.press("Set the clocks", form);
}

/** The clocks, then the key that makes the circle. */
export async function setClocks(owner, sheet, clocks) {
  const form = sheet.getByRole("form", { name: "Set the clocks" });
  await expect(form).toBeVisible();
  const { minutes, hours, days } = clocks;
  await owner.type("Minutes to approve", String(minutes), form);
  await owner.type("Hours before a share is released", String(hours), form);
  await owner.type("Days a request lasts", String(days), form);
  return form;
}

/** Make the circle; the sheet moves on to its packets. */
export async function makeCircle(owner, sheet, form) {
  await owner.press("Make the circle", form);
  await expect(owner.key("Save the recovery file", sheet)).toBeVisible();
}

/** The recovery file, saved by its key: a download, kept on disk for the recipient. */
export async function saveRecoveryFile(owner, sheet, file) {
  const saved = await owner.download("Save the recovery file", sheet);
  fs.writeFileSync(file, saved.text);
  await expect(owner.mark("The recovery file was saved", sheet)).toBeVisible();
  return { name: saved.name, file };
}

/** A guardian's packet, copied from the Packets step. */
export async function copyPacketFor(owner, sheet, name) {
  return owner.copy(`${name}'s packet`, sheet);
}

/** A guardian's receipt pasted in and added: they hold a share. */
export async function addReceipt(owner, sheet, { receipt, name }) {
  const field = await owner.paste("A contact's receipt", receipt, sheet);
  await expect(sheet.locator(".tc-fact")).toContainText(`${name}'s receipt`);
  await owner.press("Add this receipt", sheet);
  await expect(owner.mark(`${name} holds a share`, sheet)).toBeVisible();
  await expect(field).toHaveValue("");
}
