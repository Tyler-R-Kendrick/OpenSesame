/** Read the configured credential through the real vault UI after cold unlock. */
import { expect } from "@playwright/test";
import { openBackend, visitBackendRoute } from "./secret-backend-browser.mjs";

export async function verifyBackendVaultCredential(
  page,
  { base, preset, fixture, width, check, field, value },
) {
  const name = `${field} · ${fixture.name} ${width}`;
  await visitBackendRoute(page, base, "vault?f=all");
  const row = page.getByRole("treeitem").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
  await page.getByRole("button", { name: "Reveal token", exact: true }).click();
  await expect(page.getByText(value, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide token", exact: true }).click();
  check(
    true,
    `${width}: ${preset.providerId} ${field.toLowerCase()} is an actual vault Token item readable after cold unlock`,
  );
  check(
    await page.evaluate(
      (secret) => !JSON.stringify(Object.values(localStorage)).includes(secret),
      value,
    ),
    `${width}: ${preset.providerId} credential is absent from plaintext browser configuration storage`,
  );
  await openBackend(page, base, preset);
}
