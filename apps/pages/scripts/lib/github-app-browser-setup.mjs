/** Actual compiled UI only; never assign browser vault/App/proof/session state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { passTheDoor } from "./front-door.mjs";
import {
  nativeEnableConnections,
  nativeVisit,
} from "./native-browser-catalog-journey.mjs";
import { PIN, waitOpen } from "./pages-journey.mjs";
import { toTheList } from "./phone-vault.mjs";
import { openBrowserBackup } from "./secret-backend-backup-oracle.mjs";

export const SOURCE_PIN = PIN;
export const TARGET_PIN = "13579246";
export const FIRST_WRITE = "Back up this vault and enable automatic backups";
export async function unlockAt(page, pin) {
  await page.getByLabel("PIN", { exact: true }).fill(pin);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
}
export async function newVault(page, { origin, base, pin, record }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await passTheDoor(page);
  await page
    .getByRole("button", { name: "Use without an account", exact: true })
    .click();
  await page.getByRole("tab", { name: "PIN", exact: true }).click();
  await page.getByLabel("Device PIN", { exact: true }).fill(pin);
  await page.getByLabel("Confirm PIN", { exact: true }).fill(pin);
  await page
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Seal with PIN", exact: true })
    .click();
  await waitOpen(page);
  await nativeEnableConnections(page, base);
  return await useDeviceIdentity(page, record);
}
/** Lazy key creation is a genuine first identity use, before any backup or export. */
async function useDeviceIdentity(page, record) {
  const original = page.viewportSize();
  assert.ok(original, "The browser run has an explicit viewport");
  const ceremony =
    original.width > 900 ? { width: 700, height: original.height } : original;
  record(
    "identity-setup",
    JSON.stringify({ viewport: ceremony, restoredViewport: original }),
  );
  try {
    if (ceremony.width !== original.width) await page.setViewportSize(ceremony);
    const open = async () => {
      await page
        .getByRole("button", { name: /^More —/ })
        .filter({ visible: true })
        .click();
      const menu = page.getByRole("dialog", { name: "More", exact: true });
      await menu
        .getByRole("button")
        .filter({ has: page.locator(".conn__name", { hasText: /^Identity$/ }) })
        .click();
      const sheet = page.getByRole("dialog", {
        name: "Identity connection",
        exact: true,
      });
      await sheet.waitFor({ timeout: 10000 });
      return sheet;
    };
    const first = await open();
    await expect(first.getByText("No session", { exact: true })).toBeVisible();
    await first
      .getByRole("button", { name: "Use this device", exact: true })
      .click();
    await first.waitFor({ state: "detached", timeout: 15000 });
    const active = await open();
    await active
      .getByText("Session active", { exact: true })
      .waitFor({ timeout: 15000 });
    const principal = /\bprn_[A-Za-z0-9_-]{43}\b/.exec(
      await active.innerText(),
    )?.[0];
    assert.ok(
      principal,
      "Normal device identity UI exposes the actual vault-key principal",
    );
    await active.getByRole("button", { name: "Close", exact: true }).click();
    await active.waitFor({ state: "detached", timeout: 10000 });
    record(
      "identity",
      JSON.stringify({
        principal,
        ceremonyViewport: ceremony,
        restoredViewport: original,
      }),
    );
    return principal;
  } finally {
    if (ceremony.width !== original.width) await page.setViewportSize(original);
    assert.deepEqual(
      page.viewportSize(),
      original,
      "Device identity setup preserves the declared journey viewport",
    );
  }
}
export function assertCarriedPrincipal(principal, identity, label) {
  assert.equal(
    principal,
    `prn_${identity.keyId}`,
    `${label} carried key matches its normal UI principal`,
  );
}
export async function githubPage(page, base) {
  await nativeVisit(page, base, "connections/github");
  await page.getByRole("radio", { name: "GitHub App", exact: true }).waitFor();
  await expect(
    page.getByRole("radio", { name: "GitHub App", exact: true }),
  ).toBeChecked();
}
export async function captureGithub(page, name, { out, fixture, record }) {
  const text = await page.locator("body").innerText();
  fixture.assertNoSecret(text);
  const dom = await page.evaluate(() => ({
    text: document.body.innerText,
    width: innerWidth,
    overflow: document.documentElement.scrollWidth > innerWidth,
    controls: [
      ...document.querySelectorAll(
        "main input, main select, main textarea, main button",
      ),
    ].map((node) => ({
      tag: node.tagName,
      label:
        node.getAttribute("aria-label") ??
        node.labels?.[0]?.textContent?.trim() ??
        node.textContent?.trim(),
      type: node.type,
      readOnly: Boolean(node.readOnly),
      disabled: Boolean(node.disabled),
    })),
  }));
  assert.equal(
    dom.overflow,
    false,
    "Actual GitHub surface has no horizontal overflow",
  );
  await page.screenshot({
    path: path.join(out, `${name}.png`),
    fullPage: false,
  });
  fs.writeFileSync(
    path.join(out, `${name}.json`),
    JSON.stringify(dom, null, 2),
    { mode: 0o600 },
  );
  record("capture", name);
}
export async function registerGithubApp(
  original,
  { base, pin, fixture, record },
) {
  await githubPage(original, base);
  await original
    .getByRole("button", { name: "Create GitHub App", exact: true })
    .click();
  await original
    .getByRole("button", { name: "Register fixture GitHub App", exact: true })
    .click();
  await original.waitForURL(
    (url) =>
      url.pathname ===
      new URL(`${base}connections/github`, url.origin).pathname,
  );
  await unlockAt(original, pin);
  await original.getByTestId("github-app-name").waitFor();
  const install = original.getByRole("link", {
    name: "Install GitHub App",
    exact: true,
  });
  const [page] = await Promise.all([
    original.context().waitForEvent("page"),
    install.click(),
  ]);
  await page
    .getByRole("button", { name: "Install fixture GitHub App", exact: true })
    .click();
  await page.waitForURL((url) => url.pathname.endsWith("/connections/github"));
  await original.close();
  await unlockAt(page, pin);
  await page.getByTestId("github-app-install").waitFor();
  await expect(page.getByTestId("github-app-owner")).toContainText(
    "fixture-owner",
  );
  assert.ok(
    fixture.summary().validAppJwtChecks > 0,
    "Actual provider verified a locally signed RSA App JWT",
  );
  record(
    "registration",
    "Actual manifest form, one-use conversion, sealed key and verified installation completed",
  );
  return page;
}
export async function bindRepository(
  page,
  name,
  { create, base, fixture, phase },
) {
  await githubPage(page, base);
  const repository = page.getByRole("combobox", {
    name: "Repository",
    exact: true,
  });
  await expect(repository).toBeEnabled();
  if (create) {
    await repository.focus();
    await page
      .getByRole("option", {
        name: "fixture-owner/existing-private",
        exact: true,
      })
      .waitFor();
  }
  await repository.fill(`fixture-owner/${name}`);
  assert.equal(
    await repository.inputValue(),
    `fixture-owner/${name}`,
    "The editable repository field preserves the exact filled slug",
  );
  await page
    .getByRole("option", {
      name: `${create ? "New · " : ""}fixture-owner/${name}`,
      exact: true,
    })
    .click();
  await expect(page.getByTestId("github-backup-repo")).toHaveText(
    `fixture-owner/${name}`,
  );
  await page.getByTestId("backup-sync-controls").waitFor();
  await providerIdle(fixture);
  // Baseline may write on binding; record it, then measure exactly one explicit manual write.
  if (phase !== "after") {
    await expect.poll(() => fixture.snapshot(name).exists).toBe(true);
    await page
      .getByTestId("backup-sync-controls")
      .getByRole("img", { name: /^Last sync / })
      .waitFor();
  }
}
export async function explicitWrite(page, name, { fixture, first }) {
  const before = fixture.snapshot(name);
  const requestCount = fixture.rows.filter(
    (row) => row.method === "PUT",
  ).length;
  const button = page.getByRole("button", {
    name: first ? FIRST_WRITE : "Sync vault backup now",
    exact: true,
  });
  await expect(button).toBeEnabled();
  await button.click();
  await page.getByRole("img", { name: "Synced", exact: true }).waitFor();
  const after = fixture.snapshot(name);
  assert.equal(
    after.putCount - before.putCount,
    1,
    "One explicit click commits exactly one provider PUT",
  );
  assert.equal(
    fixture.rows.filter((row) => row.method === "PUT").length - requestCount,
    1,
    "No duplicate submitted PUT hidden by conditional SHA refusal",
  );
  assert.ok(
    after.exists && after.head && after.bytes > 0,
    "Actual provider commit and immutable ciphertext exist",
  );
  return after;
}
export async function addCanary(page, { base, name, value }) {
  await nativeVisit(page, base, "vault/new/secret");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Secret value", { exact: true }).fill(value);
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
  return page.url();
}
export function contains(body, expected) {
  return body.items.some(
    (item) =>
      item.deletedAt === null &&
      item.name === expected.name &&
      item.value === expected.value,
  );
}
export async function editCanary(page, { base, route, name, value }) {
  await nativeVisit(page, base, route);
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await page.getByLabel("Secret value", { exact: true }).fill(value);
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
}
async function openPhoneExport(page) {
  const fab = page.locator(".fab__add").filter({ visible: true });
  await expect(fab).toHaveCount(1);
  // Use the Add button's supported keyboard menu. A raw touch at a cached
  // coordinate can land on the list while the restored route settles.
  await fab.focus();
  await fab.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Add actions", exact: true });
  await menu
    .getByRole("menuitem", { name: "Export items", exact: true })
    .click();
}
export async function exportedBody(page, name, { base, pin, out }) {
  await nativeVisit(page, base, "vault");
  await toTheList(page);
  const key = page
    .getByRole("button", { name: "Export items", exact: true })
    .filter({ visible: true });
  if (await key.count()) await key.click();
  else await openPhoneExport(page);
  const sheet = page.getByRole("dialog", {
    name: "Export encrypted vault",
    exact: true,
  });
  await sheet.waitFor();
  await sheet
    .getByRole("button", { name: "Backup actions", exact: true })
    .click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("menuitem", { name: "Download backup", exact: true })
      .click(),
  ]);
  const file = path.join(out, `${name}.encrypted.json`);
  await download.saveAs(file);
  fs.chmodSync(file, 0o600);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await sheet.waitFor({ state: "detached" });
  return openBrowserBackup(fs.readFileSync(file, "utf8"), pin);
}

/** Actual socket outcomes settle; keep the same normal locator deadline. */
export async function providerIdle(fixture) {
  let key = "";
  let since = Date.now();
  await expect
    .poll(() => {
      const current = fixture.rows
        .map((row) => `${row.status}:${row.closed}`)
        .join("|");
      if (current !== key) {
        key = current;
        since = Date.now();
      }
      return (
        fixture.rows.every((row) => row.closed) && Date.now() - since >= 500
      );
    })
    .toBe(true);
}
