/** Pick real files, preview while offline, then explicitly import through the actual vault port. */
import { expect } from "@playwright/test";
import { backupImportFixtures } from "./backup-import-fixtures.mjs";
import { unlockWithPin } from "./pages-journey.mjs";
import {
  backendCrud,
  connectBackend,
  disconnectBackend,
  openBackend,
  saveBackend,
} from "./secret-backend-browser.mjs";

async function importOfflineFile(
  page,
  { fixture, base, presets, width, check },
) {
  const preset = presets.find(
    (entry) => entry.providerId === fixture.providerId,
  );
  await openBackend(page, base, preset);
  await page
    .getByLabel("Connection method", { exact: true })
    .selectOption("file-import");
  await page
    .getByLabel("Export format", { exact: true })
    .selectOption(fixture.format);
  await saveBackend(page);
  await page
    .getByLabel("Export file", { exact: true })
    .setInputFiles(fixture.file);
  // Warm the real parser's optional chunks without importing any records.
  await page
    .getByRole("button", { name: "Test secret backend", exact: true })
    .click();
  await page
    .getByRole("img", {
      name: "Secret backend connection verified",
      exact: true,
    })
    .waitFor({ timeout: 30_000 });
  await page.context().setOffline(true);
  try {
    await connectBackend(page);
    await page
      .getByRole("button", { name: "List backend items", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: `Read notes for ${fixture.name}`,
        exact: true,
      })
      .click();
    await expect(page.getByLabel("Backend notes", { exact: true })).toHaveValue(
      fixture.notes,
    );
    await expect(
      page.getByRole("button", { name: "New backend item", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "Import backend items into local vault",
        exact: true,
      })
      .click();
    await page
      .getByRole("img", { name: /^1 items imported; 0 skipped/ })
      .waitFor({ timeout: 30_000 });
    check(
      await page.evaluate(() => navigator.onLine === false),
      `${width}: ${fixture.file.name} previews and imports with the real browser offline`,
    );
    await disconnectBackend(page);
  } finally {
    await page.context().setOffline(false);
  }
}

export async function offlineBackendImports(
  page,
  { base, origin, presets, width, check },
) {
  // Load the note editor through the actual local-vault UI before going offline.
  const local = presets.find((entry) => entry.providerId === "local-vault");
  await openBackend(page, base, local);
  await connectBackend(page);
  await backendCrud(page, {
    name: `browser-local-note-${width}`,
    kind: "note",
    origin,
    width,
    check,
  });
  await disconnectBackend(page);
  const fixtures = backupImportFixtures(origin);
  for (const fixture of fixtures)
    await importOfflineFile(page, { fixture, base, presets, width, check });
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPin(page);
  const byo = presets.find(
    (entry) => entry.providerId === "byo-secret-backend",
  );
  await openBackend(page, base, byo);
  await expect(
    page.getByLabel("Connection method", { exact: true }),
  ).toHaveValue("file-import");
  await expect(page.getByLabel("Export file", { exact: true })).toHaveValue("");
  check(
    true,
    `${width}: file configuration survives reload, while the selected export stays transient`,
  );
  await openBackend(page, base, local);
  await connectBackend(page);
  await page
    .getByRole("button", { name: "List backend items", exact: true })
    .click();
  for (const fixture of fixtures) {
    await page
      .getByRole("button", {
        name: `Read notes for ${fixture.name}`,
        exact: true,
      })
      .click();
    await expect(page.getByLabel("Backend notes", { exact: true })).toHaveValue(
      fixture.notes,
    );
    check(
      true,
      `${width}: imported ${fixture.file.name} is readable from the real local vault after cold reload`,
    );
  }
  await disconnectBackend(page);
}

export async function officialOnePasswordHandoff(
  page,
  { base, presets, check, width },
) {
  await openBackend(
    page,
    base,
    presets.find((entry) => entry.providerId === "1password"),
  );
  const panel = page.getByRole("region", {
    name: "Save in 1Password",
    exact: true,
  });
  await panel
    .getByRole("button", {
      name: "List local logins for 1Password",
      exact: true,
    })
    .click();
  await panel
    .getByLabel("Local login", { exact: true })
    .selectOption({ label: "Imported origin login" });
  await panel
    .getByRole("button", {
      name: "Prepare official 1Password save button",
      exact: true,
    })
    .click();
  const element = panel.locator("onepassword-save-button");
  await element.waitFor();
  const facts = await element.evaluate((node) => ({
    registered: !!customElements.get("onepassword-save-button"),
    type: node.getAttribute("data-onepassword-type"),
    title: JSON.parse(atob(node.getAttribute("value"))).title,
    disabled: node.shadowRoot.querySelector(
      "button[data-onepassword-save-button]",
    ).disabled,
    activations: window.__officialSaveActivations,
  }));
  expect(facts).toMatchObject({
    registered: true,
    type: "login",
    title: "Imported origin login",
    disabled: true,
  });
  check(
    facts.activations > 0,
    `${width}: official 1Password1.3 custom element and activation event are real; unlocked extension save is not claimed`,
  );
  await panel
    .getByRole("button", { name: "Clear 1Password save request", exact: true })
    .click();
  await expect(element).toHaveCount(0);
  check(
    true,
    `${width}: explicit clear removes the volatile 1Password save payload`,
  );
}
