import { expect } from "@playwright/test";
import { openIdentityView } from "./local-directory-navigation.mjs";
import { expectTrayRaised } from "./tray-contract.mjs";

export async function localApplicationContract(page, tabTo) {
  async function activate(control) {
    await tabTo(page, control);
    await page.keyboard.press("Enter");
  }
  await openIdentityView(page, tabTo, "Applications");
  const panel = page.locator('.record-workspace[data-section="Identity"]');
  await activate(
    panel.getByRole("button", { name: "New application", exact: true }),
  );
  await expect(
    panel.getByRole("textbox", { name: "Name", exact: true }),
  ).toBeFocused();
  await page.keyboard.type("Keyboard relying party");
  await page.keyboard.press("Enter");
  const row = panel.locator(".vault__detail");
  const disclosure = row.locator("summary", {
    hasText: "Application registration",
  });
  await activate(disclosure);
  const organization = row.getByRole("combobox", {
    name: "Organization",
    exact: true,
  });
  await tabTo(page, organization);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  const redirects = row.getByRole("textbox", {
    name: "Redirect URIs (one per line)",
    exact: true,
  });
  await tabTo(page, redirects);
  await page.keyboard.type("https://rp.example.test/callback#unsafe");
  const save = row.getByRole("button", {
    name: "Save registration",
    exact: true,
  });
  await activate(save);
  await expectTrayRaised(page);
  await expect(redirects).toHaveValue(
    "https://rp.example.test/callback#unsafe",
  );
  await tabTo(page, redirects);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("https://rp.example.test/callback");
  const ownerRead = await configureScopeRoles(page, row, tabTo);
  await activate(save);
  await expect(
    row.getByText("Registered locally. Access still requires authorization.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(save).toBeFocused();
  await activate(disclosure);
  await activate(disclosure);
  await expect(redirects).toHaveValue("https://rp.example.test/callback");
  await expect(ownerRead).toBeChecked();
  await expect(
    row.getByRole("checkbox", { name: "records:read: member", exact: true }),
  ).not.toBeChecked();
  await ownerRead.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/tmp/opensesame-local-applications-${page.viewportSize().width}.png`,
  });
  await removeRegistration(page, row, tabTo);
  await expect(disclosure).toBeFocused();
  console.log(
    "PASS keyboard-only application registration, invalid callback refusal, scope policy persistence and confirmed removal",
  );
}

async function configureScopeRoles(page, panel, tabTo) {
  const scopes = panel.getByRole("textbox", {
    name: "Allowed scopes (space separated)",
    exact: true,
  });
  await tabTo(page, scopes);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("openid records:read");
  const ownerRead = panel.getByRole("checkbox", {
    name: "records:read: owner",
    exact: true,
  });
  await expect(ownerRead).not.toBeChecked();
  await tabTo(page, ownerRead);
  await page.keyboard.press("Space");
  return ownerRead;
}

async function removeRegistration(page, panel, tabTo) {
  await tabTo(
    page,
    panel.getByRole("button", { name: "Remove registration", exact: true }),
  );
  await page.keyboard.press("Enter");
  const confirm = panel.getByRole("button", {
    name: "Confirm removal",
    exact: true,
  });
  await expect(confirm).toBeFocused();
  await tabTo(
    page,
    panel.getByRole("button", { name: "Keep registration", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("button", { name: "Remove registration", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(
    panel.getByText("Not registered for local application access.", {
      exact: true,
    }),
  ).toBeVisible();
}
