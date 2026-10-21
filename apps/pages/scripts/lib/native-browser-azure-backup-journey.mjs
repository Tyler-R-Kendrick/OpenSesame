/** Explicit fresh-vault-only compiled acceptance; the full catalog walk stays list/get only. */
import { expect } from "@playwright/test";
import { nativeVerifiedCapture } from "./native-browser-api-lifecycle.mjs";
import {
  AZURE_SECRETS_FIXTURE,
  nativeAzureSecretsJourney,
} from "./native-browser-azure-secrets.mjs";
import { nativeVisit } from "./native-browser-catalog-journey.mjs";
import { PIN, unlockWithPin } from "./pages-journey.mjs";
import { openBrowserBackup } from "./secret-backend-backup-oracle.mjs";

const CANARY = {
  name: "Azure backup source",
  value: "azure-browser-backup-private-canary",
};
async function addCanary(page, base) {
  await nativeVisit(page, base, "vault/new/secret");
  await page.getByLabel("Name", { exact: true }).fill(CANARY.name);
  await page.getByLabel("Secret value", { exact: true }).fill(CANARY.value);
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: CANARY.name, exact: true }),
  ).toBeVisible();
  return page.url();
}
async function purgeCanary(page, base, sourceURL) {
  await nativeVisit(page, base, sourceURL.split(base)[1]);
  const detail = page.locator(".detail");
  await detail
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await detail
    .getByRole("button", { name: "Really move to trash?", exact: true })
    .click();
  await nativeVisit(page, base, "vault?f=trash");
  await page.getByText(`${CANARY.name}.secret`, { exact: true }).click();
  await detail
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await detail
    .getByRole("button", {
      name: "Really delete permanently? This cannot be undone",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(`${CANARY.name}.secret`, { exact: true }),
  ).toHaveCount(0);
}
async function upload(page, authority, label) {
  const name = `opensesame-browser-backup-${label}`;
  await page.getByLabel("Backup name", { exact: true }).fill(name);
  await page
    .getByRole("button", { name: "Back up encrypted vault", exact: true })
    .click();
  await expect(
    page.getByRole("img", {
      name: "Encrypted vault backup saved and verified",
      exact: true,
    }),
  ).toBeVisible();
  const id = await page
    .getByLabel("Saved backup ID", { exact: true })
    .inputValue();
  expect(id).toBe(`${AZURE_SECRETS_FIXTURE.vaultURL}/secrets/${name}`);
  const stored = authority.azureBackup.saved.get(name);
  expect(stored).toBeTruthy();
  const body = await openBrowserBackup(stored.value, PIN);
  expect(body.items).toEqual(
    expect.arrayContaining([expect.objectContaining(CANARY)]),
  );
  for (const secret of [
    PIN,
    CANARY.name,
    CANARY.value,
    AZURE_SECRETS_FIXTURE.token,
  ])
    expect(stored.value).not.toContain(secret);
  expect(Buffer.byteLength(stored.value)).toBeLessThanOrEqual(25 * 1024);
  return id;
}
async function restore(page, reference, harness, authority) {
  await page.getByLabel("Backup name or ID", { exact: true }).fill(reference);
  const password = page.getByLabel("Backup password or PIN", { exact: true });
  const action = page.getByRole("button", {
    name: "Restore encrypted vault backup",
    exact: true,
  });
  await password.fill("13579246");
  const before = authority.azureBackup.calls.length;
  await action.click();
  await expect(password).toHaveValue("");
  await expect(
    page.locator('[aria-label="Restore vault backup"] .status-mark--err'),
  ).toBeVisible();
  harness.check(
    authority.azureBackup.calls.length > before,
    "azure-sm: wrong PIN reads real encrypted backup and restores nothing",
  );
  await password.fill(PIN);
  await action.click();
  await expect(password).toHaveValue("");
  await expect(
    page.getByRole("img", {
      name: /^[1-9][0-9]* items restored from encrypted backup$/,
    }),
  ).toBeVisible();
}
async function backupRoundTrip(page, harness, authority, options) {
  const { base, label, out, sourceURL } = options;
  const reference = await upload(page, authority, label);
  await purgeCanary(page, base, sourceURL);
  await nativeVisit(page, base, "settings/connections/azure-sm");
  await expect(
    page.getByLabel("Key Vault access token", { exact: true }),
  ).toHaveValue("");
  await restore(page, reference, harness, authority);
  await nativeVisit(page, base, sourceURL.split(base)[1]);
  await expect(
    page.getByRole("heading", { name: CANARY.name, exact: true }),
  ).toBeVisible();
  authority.state.expectedDocuments.add(page.url());
  await page.reload();
  await unlockWithPin(page);
  await expect(
    page.getByRole("heading", { name: CANARY.name, exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Secret value", { exact: true })).toHaveValue(
    CANARY.value,
  );
  await nativeVisit(page, base, "settings/connections/azure-sm");
  await nativeVerifiedCapture(
    page,
    `${out}/${label}-azure-encrypted-backup-restored.png`,
  );
  harness.check(
    authority.azureBackup.calls.some((call) => call.method === "PUT") &&
      authority.azureBackup.calls.filter((call) => call.method === "GET")
        .length >= 3,
    "azure-sm: real encrypted PUT, readback and PIN restore survive cold reload",
  );
}
export async function nativeAzureEncryptedBackupJourney(
  page,
  harness,
  authority,
  options,
) {
  const sourceURL = await addCanary(page, options.base);
  const result = await nativeAzureSecretsJourney(page, harness, authority, {
    ...options,
    beforeRemove: (active, h, owned, current) =>
      backupRoundTrip(active, h, owned, { ...current, sourceURL }),
  });
  return {
    ...result,
    encryptedBackup: true,
    encryptedRestore: true,
    assurance:
      "synthetic documented Key Vault PUT/readback with actual PIN-sealed ciphertext and cold importer restore; no public Azure account, token issuance or production CORS proof",
  };
}
