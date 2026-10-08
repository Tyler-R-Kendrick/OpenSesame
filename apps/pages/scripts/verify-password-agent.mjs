// Real built PWA: the 2password workflows where they live on an item, a password row,
// Password health and New item. Local-vault semantics; never claims op:// parity.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { doorGuest } from "./lib/front-door.mjs";
import { openSettingsCategory } from "./lib/pages-journey.mjs";
import {
  verifyAccountPassword,
  verifyHealthFindings,
  verifySecretItem,
} from "./lib/password-item-context.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const out = process.env.PAGES_VERIFY_OUT ?? "/tmp/opensesame-password-agent";
const reportPath =
  process.env.PASSWORD_AGENT_REPORT ?? "work/2password-pwa-report.json";
fs.rmSync(reportPath, { force: true });
fs.mkdirSync(out, { recursive: true });
const harness = createHarness({
  dist:
    process.env.EVIDENCE_DIST ?? path.resolve(import.meta.dirname, "../dist"),
  origin,
  base,
  out,
});
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
});
try {
  for (const width of [1280, 390]) {
    const { page, context } = await harness.newPage(browser, {
      device: {
        viewport: { width, height: 900 },
        isMobile: width < 600,
        hasTouch: width < 600,
      },
    });
    await page.goto(`${origin}${base}`);
    await doorGuest(page).click();
    await page
      .getByRole("button", { name: "Lock vault" })
      .locator("visible=true")
      .first()
      .waitFor();
    await openSettingsCategory(page, "Vaults");
    const switchOn = async (pack) => {
      const control = page.getByRole("switch", { name: pack, exact: true });
      if ((await control.getAttribute("aria-checked")) === "false")
        await control.click();
      await page.waitForFunction((label) => {
        const found = document.querySelector(
          `[role="switch"][aria-label="${label}"]`,
        );
        return (
          found?.getAttribute("aria-checked") === "true" &&
          found?.getAttribute("aria-busy") !== "true"
        );
      }, pack);
    };
    // An account offers only the credential types this vault switched on
    // (ADR 0179): Account brings Password with it, the other two are asked for.
    await switchOn("Account");
    // A type chosen while an account is a draft belongs to the draft: abandon
    // the account and the vault has not switched it on.
    await page.evaluate((route) => {
      history.pushState(null, "", route);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `${base}vault/new/account`);
    await page.getByRole("button", { name: "Add login method" }).click();
    await page.getByRole("button", { name: "API key", exact: true }).click();
    await page.getByRole("group", { name: "API key method" }).waitFor();
    await page.evaluate((route) => {
      history.pushState(null, "", route);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `${base}vault`);
    await openSettingsCategory(page, "Vaults");
    await page.waitForFunction(() => {
      const found = document.querySelector(
        '[role="switch"][aria-label="API key"]',
      );
      return (
        found !== null &&
        found.getAttribute("aria-checked") === "false" &&
        found.getAttribute("aria-busy") !== "true"
      );
    });
    for (const pack of ["API key", "Token"]) await switchOn(pack);
    await page.evaluate((route) => {
      history.pushState(null, "", route);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `${base}vault/new/account`);
    await page
      .getByLabel("Name", { exact: true })
      .first()
      .fill("Gauntlet Account");
    await page
      .getByRole("button", { name: "Password options", exact: true })
      .click();
    await page.getByLabel("Password generator").selectOption("manual");
    await page.getByLabel("Include pepper", { exact: true }).uncheck();
    const passwordInput = page.getByLabel("Password", { exact: true });
    const passwordInputId = await passwordInput.getAttribute("id");
    assert.ok(passwordInputId?.endsWith("-password"));
    const methodIds = {
      Password: passwordInputId.slice(0, -"-password".length),
    };
    await passwordInput.fill("old-private-password");
    for (const [choice, value] of [
      ["API key", "context-private-api-key"],
      ["Token", "context-private-token"],
    ]) {
      await page.getByRole("button", { name: "Add login method" }).click();
      await page.getByRole("button", { name: choice, exact: true }).click();
      const inputLabel = choice === "API key" ? "X-Api-Key value" : choice;
      const methodInput = page.getByLabel(inputLabel, { exact: true });
      const methodInputId = await methodInput.getAttribute("id");
      const suffix = choice === "API key" ? "-key" : "-token";
      assert.ok(methodInputId?.endsWith(suffix));
      methodIds[choice] = methodInputId.slice(0, -suffix.length);
      await methodInput.fill(value);
    }
    await page.getByRole("button", { name: "Save item" }).first().click();
    await page.waitForURL((url) => /\/vault\/[^/]+$/.test(url.pathname));
    await page
      .getByRole("button", { name: "Save item" })
      .first()
      .waitFor({ state: "detached" });
    const accountId = new URL(page.url()).pathname.split("/").pop();
    const secretId = await verifySecretItem(
      page,
      base,
      width,
      out,
      "PRIVATE_BROWSER_SENTINEL",
    );
    await verifyHealthFindings(page, base, secretId);
    await verifyAccountPassword(page, base, accountId, methodIds, width, out);
    await context.close();
  }
  assert.deepEqual(harness.failures, []);
  const report = reportPath;
  fs.mkdirSync(path.dirname(report), { recursive: true });
  const covered = [
    "account.method-custody",
    "item-context.invocation",
    "health-context.invocation",
    "inventory.safe-metadata",
    "audit.invocation",
    "create.private-input",
    "password.compare",
    "password.apply",
    "password.invocation",
    "env.write",
    "env.resolve",
    "read.explicit",
  ];
  fs.writeFileSync(
    report,
    JSON.stringify(
      {
        testResults: [
          {
            assertionResults: covered.map((id) => ({
              fullName: `2password PWA runtime ${id}`,
              status: "passed",
            })),
          },
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PWA password workflows on the item, its password row, Health and New item passed at desktop and phone widths.",
  );
} finally {
  await browser.close();
}
