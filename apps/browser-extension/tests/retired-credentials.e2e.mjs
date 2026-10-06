/** MV3 worker admission and the real extension security settings. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const autofill = process.argv.includes("--autofill");
const target = autofill ? "autofill" : "main";
const root = fileURLToPath(
  new URL(
    autofill ? "../../browser-extension-autofill/" : "../",
    import.meta.url,
  ),
);
const dist = path.join(root, ".output/chrome-mv3");
const manifest = JSON.parse(
  fs.readFileSync(path.join(dist, "manifest.json"), "utf8"),
);
const out =
  process.env.RETIRED_EXTENSION_EVIDENCE_OUT ??
  fileURLToPath(
    new URL(
      `../../../docs/evidence/2026-10-06-retired-credential-release/extensions/${target}`,
      import.meta.url,
    ),
  );
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "os-retired-extension-"));
fs.mkdirSync(out, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
const page = await context.newPage();
const failures = [];
const moduleFailures = [];
page.on("pageerror", (error) => failures.push(error.stack ?? error.message));
page.on("requestfailed", (request) => {
  const url = new URL(request.url());
  if (url.protocol === "chrome-extension:")
    moduleFailures.push({
      path: url.pathname,
      error: request.failure()?.errorText,
    });
});
const current = "current-extension-password-2026";
const reject = "retired-extension-reject-password";
const synthetic = "retired-extension-synthetic-password";
const realName = `Owner production note ${target}`;
const policyFile = "/etc/chromium/policies/managed/extensions.json";
const managedPolicy = fs.existsSync(policyFile)
  ? JSON.parse(fs.readFileSync(policyFile, "utf8"))
  : null;
const manifestSha256 = createHash("sha256")
  .update(fs.readFileSync(path.join(dist, "manifest.json")))
  .digest("hex");
let featureAssertionsExecuted = false;
let initializationStage = "extension-discovery";

async function enroll(password, response) {
  await page
    .getByLabel("Current vault password", { exact: true })
    .fill(current);
  await page
    .getByLabel("Retired vault password", { exact: true })
    .fill(password);
  await page.getByLabel("Retired password response").selectOption(response);
  await page
    .getByRole("checkbox", { name: /retained verifiers allow offline/ })
    .check();
  await page
    .getByRole("button", { name: "Enroll retired password", exact: true })
    .click();
  await expect(
    page.getByLabel("Retired vault password", { exact: true }),
  ).toHaveValue("");
}

async function unlock(password) {
  await page.getByLabel("Vault password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
}

try {
  await page.goto("chrome://extensions/");
  const card = page
    .locator("extensions-item", { hasText: manifest.name })
    .first();
  await card.waitFor({ timeout: 10000 });
  const id = await card.getAttribute("id");
  assert.ok(id);
  initializationStage = "extension-document-load";
  await page.goto(
    `chrome-extension://${id}/${autofill ? "popup.html" : "options.html#security"}`,
  );
  initializationStage = "security-panel-initialization";
  await page.getByLabel("Vault password", { exact: true }).fill(current);
  featureAssertionsExecuted = true;
  initializationStage = "feature-assertions";
  await page
    .getByLabel("Confirm new vault password", { exact: true })
    .fill(current);
  await page.getByRole("button", { name: "Create vault password" }).click();
  await page.getByLabel("Note title").waitFor();
  await page.getByLabel("Note title").fill(realName);
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page.getByText(realName, { exact: true }).waitFor();
  await expect(page.getByLabel("Retired password response")).toHaveValue(
    "reject",
  );
  await enroll(current, "reject");
  await expect(
    page.getByRole("button", { name: "Remove trap", exact: true }),
  ).toHaveCount(0);
  await enroll(reject, "reject");
  await enroll(synthetic, "synthetic_decoy");
  await page.screenshot({ path: path.join(out, "owner-enrollment.png") });
  await page.getByRole("button", { name: "Lock vault", exact: true }).click();
  await page.reload();
  await unlock("unknown-extension-password");
  await page
    .getByText("The password did not open this vault.", { exact: true })
    .waitFor();
  await unlock(reject);
  await page
    .getByText("The password did not open this vault.", { exact: true })
    .waitFor();
  await unlock(synthetic);
  await page.getByText("Example account", { exact: true }).waitFor();
  assert.equal(await page.getByText(realName, { exact: true }).count(), 0);
  assert.equal(
    await page.getByLabel("Current vault password", { exact: true }).count(),
    0,
  );
  await expect(
    page.locator(autofill ? "main.shell" : "#production-controls"),
  ).toBeHidden();
  if (!autofill) {
    for (const securityPermit of [undefined, "forged-production-permit"]) {
      const denied = await page.evaluate(
        (permit) =>
          chrome.runtime.sendMessage({
            type: "opensesame.runner.status",
            securityPermit: permit,
          }),
        securityPermit,
      );
      assert.equal(denied.error, "vault_locked");
    }
  }
  if (autofill) {
    for (const message of [
      { type: "opensesame.fill", op: "status" },
      {
        type: "opensesame.fill",
        op: "trigger",
        reference: "production-reference",
      },
      { type: "opensesame.fill.pair" },
    ]) {
      for (const securityPermit of [undefined, "forged-production-permit"]) {
        const reply = await page.evaluate(
          (request) => chrome.runtime.sendMessage(request),
          { ...message, securityPermit },
        );
        assert.equal(reply.error, "vault_locked");
        assert.equal("value" in reply, false);
      }
    }
  }
  await page.screenshot({ path: path.join(out, "synthetic-isolation.png") });
  await page.getByRole("button", { name: "Lock vault", exact: true }).click();
  await unlock(current);
  await page.getByText(realName, { exact: true }).waitFor();
  await page.getByText(/Local observations: 2\./).waitFor();
  await page.screenshot({ path: path.join(out, "owner-recovery.png") });
  assert.deepEqual(failures, []);
  fs.writeFileSync(
    path.join(out, "results.json"),
    `${JSON.stringify({ result: "passed", target, manifestSha256, featureAssertionsExecuted, checks: ["MV3 owner admission", "current-password collision refused", "unknown password refused", "reject default and trap", "synthetic trap", "owner data excluded", autofill ? "production fill/status/pair denied" : "production runner denied", "fresh authentication restores owner", "local observations"] }, null, 2)}\n`,
  );
  console.log(
    `PASS MV3 ${target} extension retired credential enrollment and isolation`,
  );
} catch (error) {
  await page.screenshot({ path: path.join(out, "failure.png") });
  fs.writeFileSync(
    path.join(out, "failure.txt"),
    await page.locator("body").innerText(),
  );
  fs.writeFileSync(
    path.join(out, "results.json"),
    `${JSON.stringify(
      {
        result:
          !featureAssertionsExecuted &&
          managedPolicy?.ExtensionInstallBlocklist?.includes("*")
            ? "blocked"
            : "failed",
        target,
        manifestSha256,
        featureAssertionsExecuted,
        initializationStage,
        pageErrors: failures,
        moduleFailures,
        reason: String(error.message ?? error),
        policy: managedPolicy?.ExtensionInstallBlocklist
          ? {
              file: policyFile,
              ExtensionInstallBlocklist:
                managedPolicy.ExtensionInstallBlocklist,
            }
          : null,
        policyChangedOrBypassed: false,
      },
      null,
      2,
    )}\n`,
  );
  throw error;
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
