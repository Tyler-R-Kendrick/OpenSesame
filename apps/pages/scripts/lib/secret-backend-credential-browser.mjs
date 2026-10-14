/** Exercise the actual browser Credential Management API through the shared workspace. */
import { expect } from "@playwright/test";
import {
  connectBackend,
  disconnectBackend,
  openBackend,
  saveBackend,
} from "./secret-backend-browser.mjs";

export async function browserCredentialFlow(
  page,
  { base, origin, presets, width, check },
) {
  await openBackend(
    page,
    base,
    presets.find((entry) => entry.providerId === "browser-credentials"),
  );
  await expect(
    page.getByLabel("Credential origin", { exact: true }),
  ).toHaveValue(origin);
  const available = await page.evaluate(
    () =>
      !!(
        window.isSecureContext &&
        window.PasswordCredential &&
        navigator.credentials?.store
      ),
  );
  check(
    available,
    `${width}: Chromium exposes actual secure-origin PasswordCredential and credentials.store`,
  );
  await saveBackend(page);
  await connectBackend(page);
  await expect(
    page.getByRole("button", { name: "List backend items", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "New backend item", exact: true })
    .click();
  await page
    .getByLabel("Item name", { exact: true })
    .fill("Browser origin credential");
  await page
    .getByLabel("Username", { exact: true })
    .fill("browser-fixture@example.invalid");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-native-fixture-password");
  await page
    .getByRole("button", { name: "Create backend item", exact: true })
    .click();
  await page
    .getByRole("img", { name: "Backend item saved", exact: true })
    .waitFor({ timeout: 30_000 });
  await page
    .getByLabel("Item name or ID", { exact: true })
    .fill("browser-fixture@example.invalid");
  await page
    .getByRole("button", { name: "Get backend item", exact: true })
    .click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
    "browser-native-fixture-password",
  );
  await expect(
    page.getByRole("button", { name: "Delete backend item", exact: true }),
  ).toHaveCount(0);
  check(
    true,
    `${width}: real credentials.store completes through the browser backend; enumeration and deletion are absent`,
  );
  await disconnectBackend(page);
}
