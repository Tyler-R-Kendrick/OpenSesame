/** Actual installed popup authority; intercepted destination is transport only. */
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { controlWorkflowNavigation } from "./controlled-navigation.mjs";

export async function provePopupWorkflows(
  context,
  id,
  current,
  retired,
  profile,
) {
  const destination = "https://tyler-r-kendrick.github.io/OpenSesame/";
  const navigation = await controlWorkflowNavigation(profile, destination);
  const { reached } = navigation;
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
  async function denied() {
    await expect(popup.locator("#production-controls")).toBeHidden();
    await expect(popup.locator("a[href]")).toHaveCount(0);
    const pages = context.pages().length;
    const button = popup.locator('button[data-workflow="inventory"]');
    // A queued/stale programmatic click must still pass the actual owner guard.
    await button.evaluate((node) => node.click());
    await expect(popup.locator("#hint")).toHaveText(
      "Unlock the real vault to continue.",
    );
    assert.equal(context.pages().length, pages);
    assert.equal(reached.length, 0);
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
    await expect(popup.locator("#production-controls")).toBeVisible();
    const opened = context.waitForEvent("page");
    await popup
      .getByRole("button", {
        name: "Find references, inventory and audit",
        exact: true,
      })
      .click();
    const target = await opened;
    await target.waitForURL(`${destination}vault?workflow=password`);
    assert.deepEqual(reached, [`${destination}vault?workflow=password`]);
    const url = new URL(target.url());
    assert.deepEqual([...url.searchParams.keys()], ["workflow"]);
    await target.close();
    await lock();
    await unlock(retired);
    await expect(popup.locator("#production-controls")).toBeHidden();
    const count = context.pages().length;
    await popup
      .locator('button[data-workflow="create"]')
      .evaluate((node) => node.click());
    await expect(popup.locator("#hint")).toHaveText(
      "Unlock the real vault to continue.",
    );
    assert.equal(context.pages().length, count);
    assert.equal(reached.length, 1);
    await lock();
    await unlock(current);
    await expect(popup.locator("#production-controls")).toBeVisible();
    assert.deepEqual(failures, []);
    assert.deepEqual(navigation.errors, []);
  } finally {
    await popup.close();
    await navigation.close();
  }
}
