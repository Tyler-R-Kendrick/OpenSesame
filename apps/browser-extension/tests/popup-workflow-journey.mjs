/** Actual installed popup: owner controls and absence of retired workflow UI. */
import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function provePopupWorkflows(context, id, current, retired) {
  const popup = await context.newPage();
  const failures = [];
  popup.on("pageerror", (error) => failures.push(error.message));
  async function unlock(password) {
    await popup.getByLabel("Vault password", { exact: true }).fill(password);
    await popup
      .getByRole("button", { name: "Unlock vault", exact: true })
      .click();
    await popup
      .getByRole("button", { name: "Lock vault", exact: true })
      .waitFor();
  }
  async function lock() {
    await popup
      .getByRole("button", { name: "Lock vault", exact: true })
      .click();
    await popup.getByLabel("Vault password", { exact: true }).waitFor();
  }
  async function removedWorkflows() {
    await expect(popup.locator("button[data-workflow]")).toHaveCount(0);
    await expect(
      popup.getByRole("region", { name: "Vault tasks" }),
    ).toHaveCount(0);
    await expect(
      popup.getByRole("region", { name: "Authorization tasks" }),
    ).toHaveCount(0);
    await expect(popup.locator("a[href]")).toHaveCount(0);
  }
  async function denied() {
    await expect(popup.locator("#production-controls")).toBeHidden();
    await removedWorkflows();
    const pages = context.pages().length;
    // A stale programmatic activation of a surviving control still requires
    // the original real-owner permit, even though its parent is hidden.
    await popup.locator("#security-open").evaluate((node) => node.click());
    await expect(popup.locator("#hint")).toHaveText(
      "Unlock the real vault to continue.",
    );
    assert.equal(context.pages().length, pages);
  }
  async function ownerControls() {
    await expect(popup.locator("#production-controls")).toBeVisible();
    await expect(
      popup.getByRole("button", { name: "Security settings", exact: true }),
    ).toBeVisible();
    await expect(
      popup.getByRole("button", { name: "Save host", exact: true }),
    ).toBeVisible();
    await expect(
      popup.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();
    await expect(
      popup.getByLabel("Host API base", { exact: true }),
    ).toBeVisible();
    await removedWorkflows();
  }
  try {
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.getByLabel("Vault password", { exact: true }).waitFor();
    await denied();
    await unlock(retired);
    await popup.getByText("Example account", { exact: true }).waitFor();
    await denied();
    await lock();
    await unlock(current);
    await ownerControls();
    await lock();
    await unlock(retired);
    await denied();
    await lock();
    await unlock(current);
    await ownerControls();
    assert.deepEqual(failures, []);
  } finally {
    await popup.close();
  }
}
