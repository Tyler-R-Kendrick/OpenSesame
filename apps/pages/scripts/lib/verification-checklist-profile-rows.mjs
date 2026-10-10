/**
 * Checklist rows that fill the trash, pick a reset mailbox, or add an
 * environment. Split from verification-checklist-features.mjs so each file
 * stays inside the module budget.
 */

import { openSettingsCategory } from "./pages-journey.mjs";
import { trashNamed } from "./verification-checklist-features.mjs";
import { mark, visibleClick } from "./verification-checklist-shot.mjs";

const FULL = "full";
const MINIMAL = "minimal-local";

async function shotOf(shot, step, target) {
  if (target && (await target.count().catch(() => 0)) > 0) {
    return shot(step, target);
  }
  return shot(step);
}

async function trashText(page) {
  return page.locator("#settings-trash").innerText();
}

async function restoreExample(page, shot, record, trash) {
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
    return false;
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
  return true;
}

async function deleteSecond(page, shot, record, trash) {
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
    return false;
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
  return true;
}

async function emptyTrash(page, shot, record, trash) {
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

/**
 * Restore one trashed item, delete another permanently, then empty the rest.
 * Example and Second are already in the trash.
 */
export async function captureTrashActions(page, shot, record) {
  const trash = page.locator("#settings-trash");
  await trash.waitFor({ state: "visible", timeout: 15_000 });
  if (!(await restoreExample(page, shot, record, trash))) return;
  if (!(await deleteSecond(page, shot, record, trash))) return;
  await emptyTrash(page, shot, record, trash);
}

async function backToVault(page) {
  const back = page.getByRole("treeitem", { name: "Back to vault" });
  if (await back.isVisible().catch(() => false)) await back.click();
}

async function captureResetEmailAbsent(page, shot, record) {
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
}

async function captureResetEmailOnAccount(page, shot, record) {
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
  await saveAccountWithResetEmail(page, shot, record, name, type);
}

async function saveAccountWithResetEmail(page, shot, record, name, type) {
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

/** The account's mailbox picker, after the full profile stored two addresses. */
export async function captureResetEmailField(page, shot, record) {
  await backToVault(page);
  if (record.profile === MINIMAL) {
    await captureResetEmailAbsent(page, shot, record);
    return;
  }
  if (record.profile !== FULL) return;
  await captureResetEmailOnAccount(page, shot, record);
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

async function markEnvironmentsOff(page, shot, record, panel) {
  const absent = !(await panel.isVisible().catch(() => false));
  const vaults = page.locator("#vaults");
  await shotOf(shot, "e1-environments-absent", vaults);
  mark(
    record,
    "E1-environments-off",
    absent,
    absent ? "panel absent" : "panel drawn",
  );
}

function markEnvironmentPanelMissing(record) {
  mark(record, "E1-environments-on", false, "Environments panel absent");
  mark(record, "E2-environment-toggle", false, "panel absent");
  mark(record, "E2-required", false, "panel absent");
  mark(record, "E2-missing-required", false, "panel absent");
}

async function captureEnvironmentRequired(page, shot, record, panel) {
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

async function captureEnvironmentsOn(page, shot, record, panel) {
  const seen = await panel
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!seen) {
    markEnvironmentPanelMissing(record);
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
  await captureEnvironmentRequired(page, shot, record, panel);
}

/** Environments off on minimal. On full: add one, require a key, read the notice. */
export async function captureEnvironments(page, shot, record) {
  const panel = page.locator("#vault-environments");
  if (record.profile === MINIMAL) {
    await markEnvironmentsOff(page, shot, record, panel);
    return;
  }
  if (record.profile !== FULL) return;
  await captureEnvironmentsOn(page, shot, record, panel);
}
