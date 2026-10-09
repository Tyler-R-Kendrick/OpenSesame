import { expect } from "@playwright/test";
import { tabToAccessControl } from "./local-access-journey.mjs";
import {
  openIdentityRecord,
  openIdentityView,
} from "./local-directory-navigation.mjs";
import { openSection } from "./pages-journey.mjs";

export async function openApplications(page) {
  await openSection(page, "identity/");
  await openIdentityView(page, tabToAccessControl, "Applications");
  const workspace = page.locator('.record-workspace[data-section="Identity"]');
  await expect(
    workspace.getByRole("tree", { name: "Applications items" }),
  ).toBeVisible();
  return workspace;
}

export async function createApplication(page, name) {
  const workspace = page.locator('.record-workspace[data-section="Identity"]');
  const create = workspace.getByRole("button", {
    name: "New application",
    exact: true,
  });
  await expect(create).toBeEnabled();
  await tabToAccessControl(page, create);
  await page.keyboard.press("Enter");
  const nameField = workspace.getByRole("textbox", {
    name: "Name",
    exact: true,
  });
  await expect(nameField).toBeFocused();
  await page.keyboard.type(name, { delay: 15 });
  await page.keyboard.press("Enter");
  await expect(nameField).toBeHidden();
  const detail = workspace.locator(".vault__detail");
  await expect(
    detail.getByRole("heading", { name, exact: true }),
  ).toBeVisible();
  await detail
    .locator("summary", { hasText: "Application registration" })
    .click();
  return detail;
}

export async function openApplication(page, name) {
  await openIdentityRecord(page, tabToAccessControl, name);
  const detail = page.locator(".record-workspace .vault__detail");
  await detail
    .locator("summary", { hasText: "Application registration" })
    .click();
  return detail;
}
