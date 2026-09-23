/** Shared password-seal and chrome helpers for experience Playwright walks. */
export const PASSWORD = "correct horse battery staple 2026";

export async function waitOpen(page) {
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 20000 });
}

export async function sealWithPassword(page) {
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

export async function unlockWithPassword(page) {
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
}

export async function lockVault(page) {
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .click();
  await page
    .getByLabel("Password", { exact: true })
    .waitFor({ timeout: 15000 });
}

export async function openSection(page, label) {
  // Section rows for access/identity/wallet/activity are capability
  // contributions and land after the core rows: wait before concluding the
  // row is absent.
  const rail = page.locator(".railtree__row", { hasText: label }).first();
  const appeared = await rail
    .waitFor({ state: "visible", timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) {
    await rail.click();
    return;
  }
  await page
    .getByText(label, { exact: true })
    .locator("visible=true")
    .first()
    .click();
}

/**
 * Choose capabilities the way a person does — Settings › Capabilities, Add,
 * Apply. A device that has approved nothing has no rail row for the sections
 * those capabilities contribute (ADR 0130), so a walk that needs one says
 * which it needs instead of pretending the row is there.
 */
export async function addCapabilities(page, titles) {
  await openSettingsCategory(page, "Capabilities");
  for (const title of titles) {
    const add = page.getByRole("button", { name: `Add ${title}`, exact: true });
    await add.waitFor({ timeout: 15000 });
    await add.click();
    const review = page.getByTestId("capability-review");
    await review.waitFor({ timeout: 10000 });
    await page.getByTestId("capability-apply").click();
    await review.waitFor({ state: "detached", timeout: 15000 });
  }
}

export async function openGeneral(page) {
  // Settings is the heading the section opens on (it has no "Preferences"
  // heading — that name went with an earlier shape of the panel).
  const heading = page.getByRole("heading", { name: "Settings" });
  if (!(await heading.isVisible().catch(() => false))) {
    await openSection(page, "settings/");
    await heading.waitFor({ timeout: 15000 });
  }
  // A reload keeps a `?file=config.yaml` location; the form is its sibling.
  if (await page.locator(".set-raw").count()) {
    await openConfigForm(page, "General");
  }
}

/** Open a Settings category without a full document navigation (keeps the vault open). */
export async function openSettingsCategory(page, label) {
  await openSection(page, "settings/");
  const link = page.getByRole("link", { name: label, exact: true });
  if (await link.count()) {
    await link.click();
  } else {
    await page
      .getByText(label, { exact: true })
      .locator("visible=true")
      .first()
      .click();
  }
}

export async function setTextarea(page, selector, yaml) {
  const source = page.locator(selector);
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

export async function runCommand(page, utterance) {
  const input = page.locator("#command-bar-input");
  await input.fill(utterance);
  await page.getByRole("button", { name: "Run command" }).click();
  await page.waitForTimeout(400);
  await page.locator(".command-bar__status").waitFor({ timeout: 8000 });
  return page.locator(".command-bar__status").innerText();
}

/**
 * Open a settings directory's `config.yaml` by its path. The rail lists the
 * file only while it shows hidden items; the command bar opens it at any
 * width, which is the road a journey that is not about the rail should take.
 */
export async function openConfigFile(page, category) {
  const opened = await runCommand(page, `settings/${category}/config.yaml`);
  if (!/Opened/i.test(opened))
    throw new Error(`config.yaml for ${category} did not open: ${opened}`);
  await page
    .getByLabel(`settings/${category}/config.yaml`, { exact: true })
    .waitFor({ timeout: 8000 });
}

/** Back from a directory's `config.yaml` to the form it spells. */
export async function openConfigForm(page, label) {
  await page
    .locator(".set__nav")
    .getByRole("link", { name: label, exact: true })
    .click();
}

/**
 * Check or clear the rail's "Show hidden items" the way a person does: the
 * context menu on a rail row. Returns whether it had to change.
 */
export async function setShowHidden(page, on) {
  await page
    .locator(".railtree__row", { hasText: "vault/" })
    .first()
    .click({ button: "right" });
  const toggle = page.getByRole("menuitemcheckbox", {
    name: "Show hidden items",
  });
  await toggle.waitFor({ timeout: 8000 });
  if ((await toggle.getAttribute("aria-checked")) === String(on)) {
    await page.keyboard.press("Escape");
    return false;
  }
  await toggle.click();
  return true;
}
