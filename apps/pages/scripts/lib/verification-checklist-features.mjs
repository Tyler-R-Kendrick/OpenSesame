/**
 * Checklist rows whose UI depends on the profile.
 *
 * minimal-local has the core vault only: password reset and environments
 * are absent. full approves both, so the walk adds mailboxes, picks one on
 * an account, switches an environment, and reads the missing-required notice.
 * Each of those is its own check id and its own screenshot.
 */

import { openSettingsCategory } from "./pages-journey.mjs";
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

async function trashText(page) {
  return page.locator("#settings-trash").innerText();
}

/**
 * Restore one trashed item, delete another permanently, then empty the rest.
 * Example and Second are already in the trash.
 */
export async function captureTrashActions(page, shot, record) {
  const trash = page.locator("#settings-trash");
  await trash.waitFor({ state: "visible", timeout: 15_000 });
  const listed = await shot("u14-trash-list", trash);
  const restore = page.getByRole("button", { name: "Restore Example" });
  const canRestore = await restore
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!canRestore) {
    mark(record, "U14-restore", false, listed.slice(0, 80));
    mark(record, "U14-delete", false, "restore did not start");
    mark(record, "U14-empty", false, "restore did not start");
    return;
  }
  await restore.click();
  await restore.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => {});
  await shot("u14-trash-restore", trash);
  const restoredBody = await trashText(page);
  mark(
    record,
    "U14-restore",
    !/Example/.test(restoredBody) && /Second/.test(restoredBody),
    restoredBody.slice(0, 80),
  );

  const armDelete = page.getByRole("button", {
    name: "Delete Second permanently",
  });
  const canDelete = await armDelete
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!canDelete) {
    mark(record, "U14-delete", false, "delete key absent");
    mark(record, "U14-empty", false, "delete did not start");
    return;
  }
  await armDelete.click();
  const confirm = page.getByRole("button", {
    name: "Really delete permanently? This cannot be undone",
  });
  await confirm.click();
  await confirm.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => {});
  const deletedBody = await trashText(page);
  await shot("u14-trash-delete", trash);
  mark(
    record,
    "U14-delete",
    /Trash is empty/.test(deletedBody),
    deletedBody.slice(0, 80),
  );

  const back = page.getByRole("treeitem", { name: "Back to vault" });
  if (await back.isVisible().catch(() => false)) await back.click();
  const moved = await trashNamed(page, "Example");
  if (!moved) {
    mark(record, "U14-empty", false, "could not trash Example again");
    return;
  }
  await openSettingsCategory(page, "Danger");
  await trash.waitFor({ state: "visible", timeout: 15_000 });
  await page
    .getByRole("button", { name: "Empty the trash" })
    .waitFor({ timeout: 8_000 });
  await page.getByRole("button", { name: "Empty the trash" }).click();
  await shot("u14-trash-empty-armed", trash);
  await page.getByRole("button", { name: "Empty the trash" }).click();
  await page.getByText("Trash is empty.").waitFor({ timeout: 8_000 });
  const emptied = await shot("u14-trash-empty", trash);
  mark(record, "U14-empty", /Trash is empty/.test(emptied));
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

/** The account's mailbox picker, after the full profile stored two addresses. */
async function backToVault(page) {
  const back = page.getByRole("treeitem", { name: "Back to vault" });
  if (await back.isVisible().catch(() => false)) await back.click();
}

/** The account's mailbox picker, after the full profile stored two addresses. */
export async function captureResetEmailField(page, shot, record) {
  await backToVault(page);
  if (record.profile === MINIMAL) {
    const opened = await visibleClick(page, "link", "New item");
    if (!opened) {
      mark(record, "R2-reset-email-absent", false, "New item absent");
      return;
    }
    await page.getByLabel("Name", { exact: true }).waitFor({ timeout: 15_000 });
    const field = page.getByLabel("Reset email");
    const count = await field.count();
    await shot("r2-reset-email-absent");
    mark(record, "R2-reset-email-absent", count === 0, `reset fields ${count}`);
    await page.goBack().catch(() => undefined);
    return;
  }
  if (record.profile !== FULL) return;
  const opened = await visibleClick(page, "link", "New item");
  if (!opened) {
    mark(record, "R2-per-item", false, "New item absent");
    return;
  }
  const name = page.getByLabel("Name", { exact: true });
  await name.waitFor({ timeout: 15_000 });
  const type = page.getByLabel("Type", { exact: true });
  if ((await type.count()) === 0) {
    mark(record, "R2-per-item", false, "no type picker");
    return;
  }
  await type.selectOption("account");
  const select = page.getByLabel("Reset email");
  const seen = await select
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!seen) {
    await shot("r2-reset-email");
    mark(record, "R2-per-item", false, "Reset email selector absent");
    return;
  }
  const options = await select.locator("option").allTextContents();
  await shot("r2-reset-email", select);
  const both =
    options.includes("one@example.com") && options.includes("two@example.com");
  mark(record, "R2-per-item", both, options.join(", "));
  if (both) await select.selectOption({ label: "one@example.com" });
  await name.fill("Reset sample");
  await page.getByLabel("Username / ID", { exact: true }).fill("walker");
  await page.getByLabel("Password", { exact: true }).fill("checklist-secret");
  await page.getByRole("button", { name: "Save item" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Reset sample" })
    .waitFor({ timeout: 15_000 })
    .catch(() => undefined);
}

async function openNotifications(page) {
  const bell = page.getByRole("button", { name: /Notifications/ }).first();
  const seen = await bell
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!seen) return false;
  await bell.click();
  await page
    .getByRole("dialog", { name: "Notifications" })
    .waitFor({ timeout: 8_000 });
  return true;
}

/** Environments off on minimal. On full: add one, require a key, read the notice. */
export async function captureEnvironments(page, shot, record) {
  const panel = page.locator("#vault-environments");
  if (record.profile === MINIMAL) {
    const absent = !(await panel.isVisible().catch(() => false));
    const vaults = page.locator("#vaults");
    await shotOf(shot, "e1-environments-absent", vaults);
    mark(
      record,
      "E1-environments-off",
      absent,
      absent ? "panel absent" : "panel drawn",
    );
    return;
  }
  if (record.profile !== FULL) return;
  const seen = await panel
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!seen) {
    mark(record, "E1-environments-on", false, "Environments panel absent");
    mark(record, "E2-environment-toggle", false, "panel absent");
    mark(record, "E2-required", false, "panel absent");
    mark(record, "E2-missing-required", false, "panel absent");
    return;
  }
  await panel.scrollIntoViewIfNeeded();
  const on = await shot("e1-environments", panel);
  mark(
    record,
    "E1-environments-on",
    /Environments/.test(on) &&
      (await panel.getByRole("button", { name: "Add environment" }).count()) ===
        1,
  );
  await panel.getByLabel("Environment name").fill("staging");
  await panel.getByRole("button", { name: "Add environment" }).click();
  const toggle = panel.locator("#vault-environment");
  await toggle.waitFor({ state: "visible", timeout: 8_000 });
  const switched = await shot("e2-environment-toggle", panel);
  mark(
    record,
    "E2-environment-toggle",
    /staging/.test(switched),
    switched.slice(0, 80),
  );
  const required = panel.getByRole("checkbox", { name: "API_TOKEN required" });
  const box = await required
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!box) {
    mark(record, "E2-required", false, "required checkbox absent");
    mark(record, "E2-missing-required", false, "required checkbox absent");
    return;
  }
  await required.check();
  const flagged = await shot("e2-required", panel);
  mark(record, "E2-required", /API_TOKEN/.test(flagged));
  const opened = await openNotifications(page);
  if (!opened) {
    mark(record, "E2-missing-required", false, "notifications bell absent");
    return;
  }
  const dialog = page.getByRole("dialog", { name: "Notifications" });
  const notice = await shot("e2-missing-required", dialog);
  mark(
    record,
    "E2-missing-required",
    /Environment/.test(notice) && /API_TOKEN/.test(notice),
    notice.slice(0, 120),
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}
