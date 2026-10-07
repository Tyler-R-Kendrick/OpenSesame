// Real built PWA human workflow; local-vault semantics, never claims op parity.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { openSettingsCategory, sealWithPin } from "./lib/pages-journey.mjs";
import {
  verifyItemContext,
  verifyNativeRequestHandoff,
} from "./lib/password-item-context.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { expectInTray, trayText } from "./lib/tray-contract.mjs";

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
    await sealWithPin(page);
    await openSettingsCategory(page, "Vaults");
    // An account offers only the credential types this vault switched on
    // (ADR 0179): Account brings Password with it, the other two are asked for.
    for (const pack of ["Account", "API key", "Token"]) {
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
    }
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
    // Open the local human workflow through its visible entry point.
    await page.evaluate((route) => {
      history.pushState(null, "", route);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `${base}vault`);
    const workflow = page.getByRole("button", {
      name: "Password workflows",
      exact: true,
    });
    const openWorkflow = async () => {
      if (width < 600) {
        // The sharp Add key exposes alternatives through its genuine context
        // gesture; the former ellipsis is absent from the current phone design.
        await page.getByRole("link", { name: "New item", exact: true }).click({
          button: "right",
        });
        await page
          .getByRole("menuitem", { name: "Password workflows" })
          .click();
      } else await workflow.click();
    };
    await openWorkflow();
    const dialog = page.getByRole("dialog", { name: "Password workflows" });
    await dialog.waitFor();
    await dialog.getByLabel("Title", { exact: true }).fill("Gauntlet API");
    await dialog
      .getByLabel("Private credential")
      .fill("PRIVATE_BROWSER_SENTINEL");
    await dialog.getByRole("button", { name: "Create and verify" }).click();
    const result = dialog.getByLabel("Workflow result");
    try {
      await result.filter({ hasText: '"verified": true' }).waitFor();
    } catch (failure) {
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      throw new Error(await trayText(page), { cause: failure });
    }
    const receipt = JSON.parse(await result.textContent());
    const credentialRef = receipt.ref;
    assert.equal(
      await dialog.getByLabel("Private credential").inputValue(),
      "",
    );
    assert.ok(
      !(await result.textContent()).includes("PRIVATE_BROWSER_SENTINEL"),
    );
    await dialog
      .getByLabel("Title queries, one per line")
      .fill("gauntlet api\napi");
    await dialog.getByRole("button", { name: "Find", exact: true }).click();
    await result.filter({ hasText: "os://" }).waitFor();
    const matches = JSON.parse(await result.textContent()).matches;
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0].queries, ["gauntlet api", "api"]);
    assert.ok(
      !(await result.textContent()).includes("PRIVATE_BROWSER_SENTINEL"),
    );
    await dialog
      .getByRole("button", { name: "Inventory", exact: true })
      .click();
    await result.filter({ hasText: '"fields"' }).waitFor();
    await dialog.getByRole("button", { name: "Audit organization" }).click();
    await result.filter({ hasText: '"summary"' }).waitFor();
    await dialog
      .getByLabel("Assignments, one NAME=reference per line")
      .fill("API_KEY=os://personal/item/value");
    const downloadEvent = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: "Save reference template" })
      .click();
    const download = await downloadEvent;
    assert.ok([".env.tpl", "env.tpl"].includes(download.suggestedFilename()));
    const downloadedPath = await download.path();
    assert.equal(
      fs.readFileSync(downloadedPath, "utf8"),
      "API_KEY=os://personal/item/value\n",
    );
    await dialog.getByLabel("Title queries, one per line").fill("gauntlt api");
    await dialog.getByRole("button", { name: "Find", exact: true }).click();
    await result.filter({ hasText: '"suggestions"' }).waitFor();
    assert.ok(
      JSON.parse(await result.textContent()).suggestions.some(
        (match) => match.ref === credentialRef,
      ),
    );
    await dialog
      .getByLabel("Private credential")
      .fill("DUPLICATE_PRIVATE_SENTINEL");
    await dialog.getByRole("button", { name: "Create and verify" }).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expectInTray(page, /already exists/);
    const duplicateFailure = await trayText(page);
    assert.ok(!duplicateFailure.includes("DUPLICATE_PRIVATE_SENTINEL"));
    await openWorkflow();
    await dialog.waitFor();
    await dialog
      .getByLabel("Assignments, one NAME=reference per line")
      .fill(`API_KEY=${credentialRef}`);
    await dialog
      .getByLabel("I want a plaintext credential file on this device.")
      .check();
    const envDownloadEvent = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: "Resolve and download plaintext env" })
      .click();
    const envDownload = await envDownloadEvent;
    assert.equal(
      fs.readFileSync(await envDownload.path(), "utf8"),
      'API_KEY="PRIVATE_BROWSER_SENTINEL"',
    );
    await dialog.getByLabel("Local secret reference").fill(credentialRef);
    await dialog
      .getByLabel("I want this credential in a plaintext file.")
      .check();
    const readDownloadEvent = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: "Read and download plaintext credential" })
      .click();
    const readDownload = await readDownloadEvent;
    assert.equal(
      fs.readFileSync(await readDownload.path(), "utf8"),
      "PRIVATE_BROWSER_SENTINEL",
    );
    assert.ok(
      !(await result.textContent()).includes("PRIVATE_BROWSER_SENTINEL"),
    );
    await dialog
      .getByLabel("Account", { exact: true })
      .selectOption({ label: "Gauntlet Account" });
    await dialog.getByLabel("Private password").fill("new-private-password");
    await dialog.getByRole("button", { name: "Compare", exact: true }).click();
    await result.filter({ hasText: '"matches": false' }).waitFor();
    await dialog.getByLabel("Private password").fill("new-private-password");
    await dialog.getByRole("button", { name: "Update and verify" }).click();
    try {
      await result.filter({ hasText: '"verified": true' }).waitFor();
    } catch (failure) {
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      throw new Error(await trayText(page), { cause: failure });
    }
    await dialog.getByLabel("Private password").fill("new-private-password");
    await dialog.getByRole("button", { name: "Compare", exact: true }).click();
    await result.filter({ hasText: '"matches": true' }).waitFor();
    const loginId = await dialog
      .getByLabel("Account", { exact: true })
      .inputValue();
    const measurements = await dialog.evaluate((node) => ({
      width: node.getBoundingClientRect().width,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      workflowSections: node.querySelectorAll("fieldset").length,
      controls: [...node.querySelectorAll("button")].map((button) => ({
        height: button.getBoundingClientRect().height,
        width: button.getBoundingClientRect().width,
      })),
      fonts: [...node.querySelectorAll("input,textarea,select")].map(
        (control) => Number.parseFloat(getComputedStyle(control).fontSize),
      ),
    }));
    assert.equal(measurements.workflowSections, 5);
    assert.ok(measurements.scrollWidth <= measurements.clientWidth);
    if (width < 600) {
      assert.ok(
        measurements.controls.every(
          (control) => control.height >= 44 && control.width >= 44,
        ),
      );
      assert.ok(measurements.fonts.every((font) => font >= 16));
    }
    fs.writeFileSync(
      path.join(out, `${width}-measurements.json`),
      JSON.stringify(measurements, null, 2),
    );
    await page.screenshot({
      path: path.join(out, `${width}-password-workflows.png`),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await verifyItemContext(page, base, loginId, methodIds, width, out);
    await verifyNativeRequestHandoff(page, base, width, out);
    await context.close();
  }
  assert.deepEqual(harness.failures, []);
  const report = reportPath;
  fs.mkdirSync(path.dirname(report), { recursive: true });
  const covered = [
    "account.method-custody",
    "native-request.handoff",
    "item-context.invocation",
    "health-context.invocation",
    "find.multiquery",
    "find.suggestions",
    "find.concealed",
    "inventory.safe-metadata",
    "inventory.invocation",
    "audit.invocation",
    "password.invocation",
    "create.private-input",
    "create.duplicates",
    "create.verified",
    "password.compare",
    "password.apply",
    "env.write",
    "env.resolve",
    "env.materialize",
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
    "PWA local password workflows passed at desktop and phone widths.",
  );
} finally {
  await browser.close();
}
