/**
 * Trusted contacts as a vault unlock policy, through the screens:
 * create people in the identity directory, enroll real browser passkeys,
 * make a 2-of-3 circle, prove one approval is not enough and two open the
 * vault, then raise the rule to 3-of-3 and prove two are still not enough
 * while the third opens it.
 *
 * WebAuthn is Chromium's virtual authenticator: the browser's own create/get
 * path, not a software seam. A physical security key is still the hardware
 * pass described in docs/validation/trusted-contacts-hardware.md.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PIN,
  addCapabilities,
  lockVault,
  openSettingsCategory,
  sealWithPin,
  unlockWithPin,
  waitOpen,
} from "./lib/pages-journey.mjs";
import { privateTempDir } from "./lib/private-files.mjs";
import { installWebAuthn } from "./lib/siop-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const origin = "https://opensesame-labs.github.io";
const base = "/OpenSesame/";
const out = process.env.PAGES_VERIFY_OUT ?? privateTempDir("trusted-unlock-");
fs.mkdirSync(out, { recursive: true });
const harness = createHarness({
  dist:
    process.env.PAGES_VERIFY_DIST ??
    fileURLToPath(new URL("../dist", import.meta.url)),
  origin,
  base,
  out,
});
const browser = await harness.launch();
const { page } = await harness.newPage(browser, {
  device: { viewport: { width: 1280, height: 1100 } },
});
const failures = [];
const check = (condition, what) => {
  harness.check(condition, what);
  if (!condition) failures.push(what);
};
const text = async (selector) => page.locator(selector).innerText();

async function unlockThroughPin() {
  if ((await page.getByLabel("PIN", { exact: true }).count()) === 0) return;
  await unlockWithPin(page);
}

async function createPersonPasskey(name) {
  await page.getByRole("button", { name: "New person", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.waitForTimeout(350);
  await page.locator("summary", { hasText: "Passkeys" }).first().click();
  await page.waitForTimeout(200);
  await page
    .getByRole("button", { name: "Enroll passkey", exact: true })
    .click();
  await page
    .getByRole("status", { name: "Passkey status" })
    .filter({ hasText: "Passkey enrolled" })
    .waitFor({ timeout: 15_000 });
}

async function openCircleEditor() {
  await openSettingsCategory(page, "Features");
  await page
    .getByRole("link", { name: "Trusted contacts", exact: true })
    .click();
  const heading = page
    .getByRole("heading", { name: "Trusted contacts", level: 2 })
    .first();
  await heading.waitFor({ timeout: 15_000 });
  await heading.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Start a circle" }).click();
  await page.getByRole("dialog", { name: "Trusted contacts" }).waitFor();
}

async function chooseThreshold(label) {
  await page.getByLabel("Required approvals").selectOption({ label });
}

try {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  await addCapabilities(page, ["Directory provisioning", "Trusted contacts"]);
  await installWebAuthn(page);

  await page.goto(`${origin}${base}identity?view=people`, {
    waitUntil: "networkidle",
  });
  await unlockThroughPin();
  for (const name of ["Ada", "Ben", "Cy"]) {
    await createPersonPasskey(name);
  }
  await harness.snap(page, "trusted-contacts-people");

  await openCircleEditor();
  for (const name of ["Ada", "Ben", "Cy"]) {
    await page.getByRole("checkbox", { name }).check();
  }
  check(
    (await page
      .getByRole("button", { name: "Enroll a passkey for Owner" })
      .count()) === 1,
    "the directory's Owner is listed without a passkey",
  );
  await harness.snap(page, "trusted-contacts-circle-editor");
  await chooseThreshold("2 of 3");
  await page.getByRole("button", { name: "Save the circle" }).click();
  await page.waitForTimeout(500);
  check(
    (await text("body")).includes("2 of 3 contacts must approve"),
    "the circle stores 2 of 3 over the directory people",
  );

  await lockVault(page);
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.getByRole("heading", { name: "Trusted contacts" }).waitFor({
    timeout: 15_000,
  });
  check(
    (await text(".unlock__trusted-line")).includes("0 of 2 approvals"),
    "the vault parks at 0 of 2 approvals",
  );
  await page.getByRole("button", { name: "Approve as Ada" }).click();
  await page.waitForTimeout(900);
  check(
    (await text(".unlock__trusted-line")).includes("1 of 2 approvals"),
    "one approval is counted",
  );
  check(
    (await page.getByRole("button", { name: "Lock vault" }).count()) === 0,
    "one of two does not unlock the vault",
  );
  await page.getByRole("button", { name: "Approve as Ben" }).click();
  await waitOpen(page);
  check(true, "two of two unlock the vault");
  await harness.snap(page, "trusted-contacts-2-of-3-unlocked");

  await openCircleEditor();
  await chooseThreshold("3 of 3");
  await page.getByRole("button", { name: "Save the circle" }).click();
  await page.waitForTimeout(500);
  check(
    (await text("body")).includes("3 of 3 contacts must approve"),
    "the circle stores 3 of 3",
  );

  await lockVault(page);
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.getByRole("heading", { name: "Trusted contacts" }).waitFor({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Approve as Ada" }).click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Approve as Ben" }).click();
  await page.waitForTimeout(900);
  check(
    (await text(".unlock__trusted-line")).includes("2 of 3 approvals"),
    "two approvals are counted toward three",
  );
  check(
    (await page.getByRole("button", { name: "Lock vault" }).count()) === 0,
    "two of three does not unlock the vault",
  );
  await page.getByRole("button", { name: "Approve as Cy" }).click();
  await waitOpen(page);
  check(true, "three of three unlock the vault");
  await harness.snap(page, "trusted-contacts-3-of-3-unlocked");

  assert.deepEqual(harness.failures, []);
  assert.deepEqual(failures, []);
  console.log(
    "PASS trusted contacts: directory people, browser WebAuthn, 2-of-3 quorum, 3-of-3 quorum, below-threshold stays locked",
  );
} finally {
  await browser.close();
}

export { out };
