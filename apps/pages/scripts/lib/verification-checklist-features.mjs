/**
 * Checklist rows whose UI depends on the profile.
 *
 * minimal-local has the core vault only: password reset and environments
 * are absent. full approves both, so the walk adds mailboxes, picks one on
 * an account, switches an environment, and reads the missing-required notice.
 * Each of those is its own check id and its own screenshot.
 */

import { mark, visibleClick } from "./verification-checklist-shot.mjs";

const FULL = "full";
const MINIMAL = "minimal-local";

async function shotOf(shot, step, target) {
  if (target && (await target.count().catch(() => 0)) > 0) {
    return shot(step, target);
  }
  return shot(step);
}

/** A secret saved from the editor. False when New item never appears. */
export async function createPlainSecret(page, name, value) {
  const opened = await visibleClick(page, "link", "New item");
  if (!opened) return false;
  const nameField = page.getByLabel("Name", { exact: true });
  await nameField.waitFor({ state: "visible", timeout: 15_000 });
  const type = page.getByLabel("Type", { exact: true });
  if ((await type.count()) > 0 && (await type.isVisible().catch(() => false))) {
    await type.selectOption("secret");
  }
  await nameField.fill(name);
  const secret = page.locator("#secret-value");
  if ((await secret.count()) === 1) await secret.fill(value);
  await page.getByRole("button", { name: "Save item" }).click();
  await page
    .locator(".vtree__row", { hasText: name })
    .first()
    .waitFor({ timeout: 15_000 });
  return true;
}

export async function trashNamed(page, name) {
  const row = page.locator(".vtree__row", { hasText: name }).first();
  if ((await row.count()) === 0) return false;
  await row.click({ button: "right" });
  const trashed = await visibleClick(page, "menuitem", "Trash", 8_000);
  if (!trashed) await page.keyboard.press("Escape");
  return trashed;
}

async function railShot(page, shot, step) {
  const tree = page.getByRole("tree").first();
  return shotOf(shot, step, tree);
}

function treeHas(text, label) {
  const line = new RegExp(`^${label}$`, "m");
  return line.test(text);
}

/**
 * Formats, Age Keys and Transport are gone from the security tree.
 * Travel sits with Duress for the owner of an open vault.
 */
export async function captureSecurityRows(page, shot, record) {
  const formats = await railShot(page, shot, "u5-formats-absent");
  mark(record, "U5-formats", !treeHas(formats, "Formats"));
  const age = await railShot(page, shot, "u6-age-keys-absent");
  mark(record, "U6-age-keys", !/Age Keys/.test(age));
  const transport = await railShot(page, shot, "u7-transport-absent");
  mark(record, "U7-transport", !treeHas(transport, "Transport"));

  const duress = page.locator("#duress-profiles");
  const travel = page.locator("#travel");
  const duressOn = await duress
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  const travelOn = duressOn
    ? await travel
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false)
    : false;
  if (duressOn) await shot("u8-duress", duress);
  else await shot("u8-duress");
  if (travelOn) await shot("u8-travel", travel);
  else await shot("u8-travel");
  mark(
    record,
    "U8-travel",
    duressOn && travelOn,
    duressOn && travelOn ? "Duress and Travel" : "duress panel absent",
  );
}

/** Sealed store is not a default vaults row. One shot of the tree. */
export async function captureSealedStore(page, shot, record) {
  const text = await railShot(page, shot, "u9-sealed-store-absent");
  mark(record, "U9-sealed-store", !/Sealed store/.test(text));
}

async function addResetEmail(section, address) {
  const input = section.getByLabel("Reset email");
  await input.fill(address);
  await section.getByRole("button", { name: "Add reset email" }).click();
  await section.getByText(address, { exact: true }).waitFor({ timeout: 8_000 });
}

/** Password reset under Capabilities: absent on minimal, 0/1/many on full. */
export async function capturePasswordReset(page, shot, record) {
  if (record.profile === MINIMAL) {
    const caps = page.locator("[data-testid=capabilities-panel]");
    const zero = await shotOf(shot, "r1-reset-absent", caps);
    const section = page.locator("#feature-password-reset");
    const shown = await section.isVisible().catch(() => false);
    mark(record, "R1-reset-absent", !shown, shown ? "section drawn" : "absent");
    await shotOf(shot, "r3-settings-absent", caps);
    mark(
      record,
      "R3-settings-absent",
      !/Password reset/.test(zero) || !shown,
      shown ? "Password reset section" : "no Password reset section",
    );
    return;
  }
  if (record.profile !== FULL) return;
  const section = page.locator("#feature-password-reset");
  const seen = await section
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!seen) {
    mark(record, "R3-settings", false, "Password reset section absent");
    mark(record, "R1-zero", false, "section absent");
    mark(record, "R1-one", false, "section absent");
    mark(record, "R1-many", false, "section absent");
    return;
  }
  await section.scrollIntoViewIfNeeded();
  const placed = await shot("r3-password-reset", section);
  mark(
    record,
    "R3-settings",
    /Password reset/.test(placed),
    "capabilities section",
  );
  const input = section.getByLabel("Reset email");
  const inputSeen = await input
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!inputSeen) {
    mark(record, "R1-zero", false, "mailbox field absent");
    mark(record, "R1-one", false, "mailbox field absent");
    mark(record, "R1-many", false, "mailbox field absent");
    return;
  }
  const zero = await shot("r1-reset-zero", section);
  const removes = await section
    .getByRole("button", { name: /^Remove / })
    .count();
  mark(
    record,
    "R1-zero",
    removes === 0 && /Reset email/.test(zero),
    "no mailboxes",
  );
  await addResetEmail(section, "one@example.com");
  const one = await shot("r1-reset-one", section);
  mark(
    record,
    "R1-one",
    /one@example.com/.test(one) && !/two@example.com/.test(one),
  );
  await addResetEmail(section, "two@example.com");
  const many = await shot("r1-reset-many", section);
  mark(
    record,
    "R1-many",
    /one@example.com/.test(many) && /two@example.com/.test(many),
  );
}
