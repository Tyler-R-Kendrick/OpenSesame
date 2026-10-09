/** Screenshots of installed actions after an actual provider-issued grant. */
import { expect } from "@playwright/test";
import { nativeVisit } from "./lib/native-browser-catalog-journey.mjs";

export async function captureVerifiedProviderMenu({ page, base, out, label }) {
  await nativeVisit(page, base, "connections#connected");
  await page
    .getByRole("button", { name: "Actions for HashiCorp Vault", exact: true })
    .click();
  const menu = page.getByRole("menu", {
    name: "HashiCorp Vault connection",
    exact: true,
  });
  await expect(
    menu.getByRole("menuitem", { name: "Configure connection", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Remove connection…", exact: true }),
  ).toBeVisible();
  await page.bringToFront();
  await page.screenshot({
    path: `${out}/${label}-vault-real-oidc-installed-menu.png`,
    fullPage: false,
    animations: "disabled",
  });
  await menu
    .getByRole("menuitem", { name: "Check access", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "HashiCorp Vault connected", exact: true }),
  ).toBeVisible();
}

export async function readAuthorizedSecret(page) {
  await page
    .locator("summary")
    .filter({ hasText: /^Read secret$/ })
    .click();
  await page.getByLabel("KV v2 mount", { exact: true }).fill("secret");
  await page.getByLabel("Secret path", { exact: true }).fill("browser-auth");
  await page.getByRole("button", { name: "Read secret", exact: true }).click();
  const reveal = page.getByRole("button", { name: /Reveal/ }).last();
  await reveal.waitFor();
  await expect(page.getByLabel("Secret path", { exact: true })).toHaveValue(
    "browser-auth",
  );
  await reveal.click();
  await expect(
    page.getByText("Authorized secret from real provider", { exact: true }),
  ).toBeVisible();
}
