// verify:tailnet-sync's page steps (ADR 0144): moving within the app, turning
// Networking on, saving an account item, and waiting for the panel to say the
// device is in step.
import { expect } from "@playwright/test";
import { chooseType } from "./editor-type.mjs";
import { toTheList } from "./phone-vault.mjs";

/** The steps for an app served under `base`. */
export function syncSteps(base) {
  async function visit(page, route) {
    await page.evaluate((href) => {
      history.pushState(null, "", href);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `${base}${route}`);
    await page.waitForTimeout(1200);
  }

  async function networkingOn(page) {
    await visit(page, "settings/capabilities");
    await page.getByRole("switch", { name: "Networking", exact: true }).click();
    await page
      .getByTestId("capability-review")
      .waitFor({ state: "detached", timeout: 20_000 });
  }

  async function saveItem(page, name) {
    await visit(page, "settings/vaults");
    const account = page.getByRole("switch", { name: "Account", exact: true });
    const held = page.getByRole("img", {
      name: /^Account stays on: this vault has \d+ items? of it\.$/,
    });
    await account
      .or(held)
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
    if (await account.count()) {
      if ((await account.getAttribute("aria-checked")) === "false")
        await account.click();
      await expect(account).toHaveAttribute("aria-busy", "false", {
        timeout: 15000,
      });
      await expect(account).toHaveAttribute("aria-checked", "true");
    } else {
      await expect(held).toBeVisible();
    }
    await visit(page, "vault");
    await toTheList(page);
    await page
      .getByRole("link", { name: "New item", exact: true })
      .first()
      .click();
    await chooseType(page, "account");
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page
      .getByLabel("Username / ID", { exact: true })
      .fill("sync-account@example.test");
    await page
      .getByLabel("Password", { exact: true })
      .fill("sync-account-secret");
    const save = page.getByRole("button", { name: "Save item", exact: true });
    await save.first().scrollIntoViewIfNeeded();
    await save.first().click();
    await page.waitForTimeout(900);
  }

  async function inStep(page) {
    const mark = page.locator("#tailnet-sync .status-mark");
    await expect(mark).toHaveAttribute("aria-label", /^In step at /, {
      timeout: 20_000,
    });
  }

  return { visit, networkingOn, saveItem, inStep };
}
