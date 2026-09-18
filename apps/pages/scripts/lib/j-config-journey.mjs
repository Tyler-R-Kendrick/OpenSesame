/**
 * J-CONFIG against the built Pages dist: Visual → Source → comment +
 * autoLockMinutes 7 → Visual → Save → lock → unlock → reload.
 * Uses a password-sealed vault so lock/unlock is the same tomb (guest
 * isolation would open a different store).
 */
const PASSWORD = "correct horse battery staple 2026";
const COMMENT = "# keep this comment through visual and lock";
const PREFS_SOURCE = `${COMMENT}
theme: dark
autoLockMinutes: 7
lockOnHide: false
signOutOnLock: false
clipboardClearSeconds: 30
`;

async function waitOpen(page) {
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 20000 });
}

async function sealWithPassword(page) {
  await page.getByRole("button", { name: "Use without an account" }).click();
  await page.getByRole("tab", { name: "Password" }).click();
  await page.getByLabel("Master password", { exact: true }).fill(PASSWORD);
  await page
    .getByLabel("Confirm master password", { exact: true })
    .fill(PASSWORD);
  await page
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  await page.getByRole("button", { name: "Seal this device" }).click();
  await waitOpen(page);
}

async function setSourceYaml(page, yaml) {
  const source = page.locator("textarea#prefs-source");
  await source.waitFor({ timeout: 8000 });
  await source.evaluate((node, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, yaml);
}

async function openGeneral(page) {
  const heading = page.getByRole("heading", { name: "Preferences" });
  if (await heading.isVisible().catch(() => false)) return;
  const link = page.getByRole("link", { name: /^settings\// }).first();
  if (await link.count()) await link.click();
  else await page.getByText("settings/", { exact: true }).first().click();
  await heading.waitFor({ timeout: 15000 });
}

async function unlockWithPassword(page) {
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
}

async function lockVault(page) {
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .click();
  await page
    .getByLabel("Password", { exact: true })
    .waitFor({ timeout: 15000 });
}

async function assertDraft(page, check, label) {
  await page.getByRole("button", { name: "Source", exact: true }).click();
  const source = page.locator("textarea#prefs-source");
  await source.waitFor({ timeout: 8000 });
  await page.waitForFunction(
    (comment) =>
      Boolean(document.querySelector("#prefs-source")?.value.includes(comment)),
    COMMENT,
    { timeout: 10000 },
  );
  const yaml = await source.inputValue();
  check(yaml.includes(COMMENT), `${label}: comment survived`);
  check(yaml.includes("autoLockMinutes: 7"), `${label}: source idle is 7`);
  check(yaml.includes("theme: dark"), `${label}: source theme is dark`);
  await page.getByRole("button", { name: "Visual", exact: true }).click();
  const idle = page.getByLabel("Lock after inactivity");
  await idle.waitFor({ timeout: 8000 });
  check(
    (await idle.inputValue()) === "7",
    `${label}: Visual idle timeout is 7`,
  );
}

export async function walkJConfig({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await openGeneral(page);
  await snap(page, "J-CONFIG-visual");
  await page.getByRole("button", { name: "Night" }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await setSourceYaml(page, PREFS_SOURCE);
  const source = page.locator("textarea#prefs-source");
  check(
    (await source.inputValue()).includes(COMMENT),
    "Source holds the comment before Visual",
  );
  await page.getByRole("button", { name: "Visual", exact: true }).click();
  const idle = page.getByLabel("Lock after inactivity");
  await idle.waitFor({ timeout: 8000 });
  check((await idle.inputValue()) === "7", "Visual shows custom idle 7");
  await snap(page, "J-CONFIG-visual-7");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await page.getByText("Preferences saved.").waitFor({ timeout: 10000 });
  check(true, "Save reported Preferences saved");
  await lockVault(page);
  await unlockWithPassword(page);
  await openGeneral(page);
  await assertDraft(page, check, "after unlock");
  await snap(page, "J-CONFIG-after-unlock");
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByLabel("Password", { exact: true })
    .waitFor({ timeout: 15000 });
  await unlockWithPassword(page);
  await openGeneral(page);
  await assertDraft(page, check, "after reload");
  await snap(page, "J-CONFIG-after-reload");
}
