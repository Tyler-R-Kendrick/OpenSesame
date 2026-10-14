/** A real encrypted vault round trip through Connect into an independently sealed browser vault. */
import { expect } from "@playwright/test";
import { passTheDoor } from "./front-door.mjs";
import { PIN, waitOpen } from "./pages-journey.mjs";
import {
  openBrowserBackup,
  verifyRestoredVaultContent,
  verifyVaultTokensInBackup,
} from "./secret-backend-backup-oracle.mjs";
import {
  connectBackend,
  disconnectBackend,
  enableBackendConnections,
  fillNativeBackend,
  newBackendPage,
  openBackend,
  saveBackend,
} from "./secret-backend-browser.mjs";

const TARGET_PIN = "13579246";
async function sealTarget(page) {
  await passTheDoor(page);
  await page
    .getByRole("button", { name: "Use without an account", exact: true })
    .click();
  await page.getByRole("tab", { name: "PIN", exact: true }).click();
  await page.getByLabel("Device PIN", { exact: true }).fill(TARGET_PIN);
  await page.getByLabel("Confirm PIN", { exact: true }).fill(TARGET_PIN);
  await page
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Seal with PIN", exact: true })
    .click();
  await waitOpen(page);
}
async function connectFixture(page, { base, preset, fixture, width }) {
  await openBackend(page, base, preset);
  await page
    .getByLabel("Connection method", { exact: true })
    .selectOption("onepassword-connect");
  await fillNativeBackend(page, fixture, "onepassword-connect", width);
  await saveBackend(page);
  await connectBackend(page);
}
async function targetRestore(
  browser,
  { origin, base, presets, fixture, reference, source, width, record, check },
) {
  const { page, context } = await newBackendPage(browser, {
    origin,
    width,
    providers: [fixture.origin],
    record,
  });
  try {
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await sealTarget(page);
    await enableBackendConnections(page, base);
    const preset = presets.find((entry) => entry.providerId === "1password");
    await connectFixture(page, { base, preset, fixture, width });
    await page.getByLabel("Backup name or ID", { exact: true }).fill(reference);
    await page.getByLabel("Backup password or PIN", { exact: true }).fill(PIN);
    await page
      .getByRole("button", {
        name: "Restore encrypted vault backup",
        exact: true,
      })
      .click();
    await expect(
      page.getByLabel("Backup password or PIN", { exact: true }),
    ).toHaveValue("");
    await page
      .getByRole("img", {
        name: /^[1-9][0-9]* items restored from encrypted backup$/,
      })
      .waitFor({ timeout: 45_000 });
    await disconnectBackend(page);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByLabel("PIN", { exact: true }).fill(TARGET_PIN);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await waitOpen(page);
    await openBackend(
      page,
      base,
      presets.find((entry) => entry.providerId === "local-vault"),
    );
    await saveBackend(page);
    await connectBackend(page);
    await page
      .getByRole("button", { name: "List backend items", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Read notes for Proton offline JSON note",
        exact: true,
      })
      .click();
    await expect(page.getByLabel("Backend notes", { exact: true })).toHaveValue(
      "Real Proton-format JSON note",
    );
    check(
      true,
      `${width}: socket-backed ciphertext backup restores actual items into another browser vault, preserving that vault's different enrolled PIN after cold reload`,
    );
    await disconnectBackend(page);
    await verifyRestoredSnapshot(page, {
      base,
      preset,
      fixture,
      source,
      width,
      check,
    });
  } finally {
    await context.close();
  }
}

async function uploadBackup(page, fixture, name) {
  await page.getByLabel("Backup name", { exact: true }).fill(name);
  await page
    .getByRole("button", { name: "Back up encrypted vault", exact: true })
    .click();
  await page
    .getByRole("img", {
      name: "Encrypted vault backup saved and verified",
      exact: true,
    })
    .waitFor({ timeout: 45_000 });
  const reference = await page
    .getByLabel("Saved backup ID", { exact: true })
    .inputValue();
  const item = fixture.items.get(reference);
  expect(item).toBeTruthy();
  return {
    reference,
    ciphertext: item.fields.find((field) => field.id === "notesPlain").value,
  };
}
async function deleteUploadedBackup(page, reference) {
  await page.getByLabel("Item name or ID", { exact: true }).fill(reference);
  await page
    .getByRole("button", { name: "Get backend item", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete backend item", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm delete backend item", exact: true })
    .click();
}
async function verifyRestoredSnapshot(
  page,
  { base, preset, fixture, source, width, check },
) {
  await openBackend(page, base, preset);
  await connectBackend(page);
  const uploaded = await uploadBackup(
    page,
    fixture,
    `Restored encrypted vault ${width}`,
  );
  const restored = await openBrowserBackup(uploaded.ciphertext, TARGET_PIN);
  verifyRestoredVaultContent(source, restored, width, check);
  await deleteUploadedBackup(page, uploaded.reference);
  await disconnectBackend(page);
}

export async function encryptedBackupRoundTrip(
  page,
  { browser, origin, base, presets, fixture, width, record, check },
) {
  const preset = presets.find((entry) => entry.providerId === "1password");
  await connectFixture(page, { base, preset, fixture, width });
  const { reference, ciphertext: serialized } = await uploadBackup(
    page,
    fixture,
    `Encrypted browser vault ${width}`,
  );
  const source = await openBrowserBackup(serialized, PIN);
  verifyVaultTokensInBackup(source, serialized, width, check);
  expect(JSON.parse(serialized).format).toBe("opensesame-offline-backup");
  for (const plaintext of [
    PIN,
    TARGET_PIN,
    "Imported origin login",
    "browser-offline-fixture-password",
    "Real Proton-format JSON note",
  ])
    expect(serialized).not.toContain(plaintext);
  check(
    true,
    `${width}: actual Connect item holds a verified canonical encrypted vault envelope without source PIN or item plaintext`,
  );
  await targetRestore(browser, {
    origin,
    base,
    presets,
    fixture,
    reference,
    source,
    width,
    record,
    check,
  });
  await deleteUploadedBackup(page, reference);
  await expect.poll(() => fixture.items.size).toBe(0);
  await disconnectBackend(page);
}
