/** Common controls exercise direct browser HTTP and encrypted personal-account CRUD. */
import { expect } from "@playwright/test";
import { PIN } from "./pages-journey.mjs";
import {
  openBrowserBackup,
  verifyVaultTokensInBackup,
} from "./secret-backend-backup-oracle.mjs";
import {
  backendCrud,
  connectBackend,
  disconnectBackend,
  fillNativeBackend,
  openBackend,
  saveBackend,
  savedBackendReload,
} from "./secret-backend-browser.mjs";
import { verifyBackendVaultCredential } from "./secret-backend-custody-browser.mjs";
import { FIXTURE_TOKEN } from "./secret-backend-fixture-http.mjs";
import { INFISICAL_CLIENT } from "./secret-backend-infisical-fixture.mjs";

const MASTER = "Master password (this connection only)";
async function unlock(page, fixture) {
  if (!fixture.nativePersonal) return;
  await expect(page.getByLabel(MASTER, { exact: true })).toHaveValue("");
  await page.getByLabel(MASTER, { exact: true }).fill(fixture.password);
}
async function nativeBackup(page, fixture, width, check) {
  await page
    .getByLabel("Backup name", { exact: true })
    .fill(`Native encrypted backup ${width}`);
  await page
    .getByRole("button", { name: "Back up encrypted vault", exact: true })
    .click();
  await page
    .getByRole("img", {
      name: "Encrypted vault backup saved and verified",
      exact: true,
    })
    .waitFor();
  const id = await page
    .getByLabel("Saved backup ID", { exact: true })
    .inputValue();
  const ciphertext = fixture.decoded.get(id)?.get("notes");
  const body = await openBrowserBackup(ciphertext, PIN);
  verifyVaultTokensInBackup(body, ciphertext, width, check);
  expect(ciphertext).not.toContain(fixture.password);
  expect(ciphertext).not.toContain(fixture.credentials.clientSecret);
  await page.getByLabel("Item name or ID", { exact: true }).fill(id);
  await page
    .getByRole("button", { name: "Get backend item", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete backend item", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm delete backend item", exact: true })
    .click();
  check(
    true,
    `${width}: native encrypted personal account stores and independently decrypts a real sealed vault backup`,
  );
}
export async function nativeConnections(
  page,
  { width, fixtures, presets, base, origin, h, snapshot },
) {
  for (const [index, providerId] of [
    "1password",
    "infisical",
    "passwordstate",
    "bitwarden",
  ].entries()) {
    const fixture = fixtures[index];
    const preset = presets.find((entry) => entry.providerId === providerId);
    h.setStep(`${width}-${providerId}-native-http`);
    console.log(`${width}-${providerId}-native-http`);
    await openBackend(page, base, preset);
    const mode =
      providerId === "1password" ? "onepassword-connect" : preset.defaultMode;
    await page
      .getByLabel("Connection method", { exact: true })
      .selectOption(mode);
    await fillNativeBackend(page, fixture, mode, width);
    await saveBackend(page);
    await savedBackendReload(page, {
      base,
      preset,
      fixture,
      width,
      check: h.check,
    });
    await verifyBackendVaultCredential(page, {
      base,
      preset,
      fixture,
      width,
      check: h.check,
      field:
        providerId === "infisical" || fixture.nativePersonal
          ? "Client secret"
          : "Access token",
      value: fixture.nativePersonal
        ? fixture.credentials.clientSecret
        : providerId === "infisical"
          ? INFISICAL_CLIENT.secret
          : FIXTURE_TOKEN,
    });
    await unlock(page, fixture);
    await page
      .getByRole("button", { name: "Test secret backend", exact: true })
      .click();
    await page
      .getByRole("img", {
        name: "Secret backend connection verified",
        exact: true,
      })
      .waitFor({ timeout: 30_000 });
    await unlock(page, fixture);
    await connectBackend(page);
    if (fixture.nativePersonal)
      await expect(page.getByLabel(MASTER, { exact: true })).toHaveValue("");
    await backendCrud(page, {
      name: `browser-${providerId}-${width}`,
      kind: providerId === "infisical" ? "secret" : "login",
      origin,
      width,
      check: h.check,
    });
    if (fixture.nativePersonal)
      await nativeBackup(page, fixture, width, h.check);
    await snapshot(page, `${width}-${providerId}-crud`);
    await disconnectBackend(page);
    const live = [...fixture.items.values()].filter(
      (item) => !item.deletedDate,
    );
    h.check(
      live.length === 0,
      `${width}: ${providerId} CRUD leaves no live provider items after deletion`,
    );
  }
}
