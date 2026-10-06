/** Real browser enrollment, routing, owner recovery and local evidence. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { phoneContext } from "./lib/mobile-contract.mjs";
import {
  PASSWORD,
  lockVault,
  sealWithPassword,
  unlockWithPassword,
  waitOpen,
} from "./lib/pages-journey.mjs";
import {
  assertFreshDocumentSealed,
  assertOpenerDocumentSealed,
  assertOwnerWitnessReadable,
  assertTrustedShiftMenu,
  observeNativeContextMenu,
} from "./lib/retired-descendant-harness.mjs";
import { retiredOfflineHarness } from "./lib/retired-offline-harness.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const offline = process.env.RETIRED_OFFLINE === "1";
const out =
  process.env.RETIRED_EVIDENCE_OUT ??
  fileURLToPath(
    new URL(
      "../../../docs/evidence/2026-10-05-retired-credential-traps/browser",
      import.meta.url,
    ),
  );
fs.mkdirSync(out, { recursive: true });
const harness = offline
  ? await retiredOfflineHarness({ dist, base })
  : createHarness({
      dist,
      base,
      origin: "https://tyler-r-kendrick.github.io",
      out,
    });
const origin = harness.origin ?? "https://tyler-r-kendrick.github.io";
const browser = await harness.launch({
  args: ["--enable-experimental-web-platform-features"],
});
const results = [];
const buildIndexSha256 = createHash("sha256")
  .update(fs.readFileSync(path.join(dist, "index.html")))
  .digest("hex");
let gate = "failed";
let currentPage;

async function visit(page, route) {
  await page.evaluate((pathname) => {
    history.pushState({}, "", pathname);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
}

async function manage(page) {
  await visit(page, "settings/security");
  await page.getByRole("button", { name: "Manage retired passwords" }).click();
  await page.getByLabel("Current vault password", { exact: true }).waitFor();
}

async function enroll(page, password, synthetic = false) {
  await page
    .getByLabel("Current vault password", { exact: true })
    .fill(PASSWORD);
  await page
    .getByLabel("Selected retired password", { exact: true })
    .fill(password);
  if (synthetic)
    await page.getByRole("radio", { name: "Open a synthetic decoy" }).check();
  await page
    .getByRole("checkbox", { name: /retaining a password-only verifier/ })
    .check();
  await page.getByRole("button", { name: "Enroll retired password" }).click();
}

async function attempt(page, password) {
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
}

async function list(page, width) {
  await visit(page, "vault");
  if (width === 390) {
    await page
      .getByRole("treeitem", { name: /^all\b/i })
      .first()
      .click();
    await page.locator(".vault[data-pane='list']").waitFor();
  }
}

async function assertSyntheticItems(page, realName) {
  await page
    .getByText("Example account.account", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    (await page.locator("body").innerText()).includes(realName),
    false,
  );
  assert.equal(
    await page
      .getByText("real-secret-do-not-disclose", { exact: true })
      .count(),
    0,
  );
}

async function assertSyntheticNavigation(page, context) {
  await page
    .getByText("Example account.account", { exact: true })
    .first()
    .click();
  const outbound = page.locator('a[aria-label="Open account.example.invalid"]');
  await expect(outbound).toHaveAttribute("aria-disabled", "true");
  assert.equal(await outbound.getAttribute("href"), null);
  const syntheticUrl = page.url();
  await outbound.click({ force: true });
  assert.equal(page.url(), syntheticUrl);
  assert.equal(context.pages().length, 1);
}

async function coldReplay(page, context, width, password, realName, prefix) {
  await lockVault(page);
  if (offline) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await cdp.detach();
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Password", { exact: true }).waitFor();
  if (offline)
    assert.equal(
      await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      true,
    );
  await attempt(page, password);
  await waitOpen(page);
  await list(page, width);
  await assertSyntheticItems(page, realName);
  await assertSyntheticNavigation(page, context);
  await page.screenshot({
    path: path.join(out, `${prefix}-replayed-synthetic.png`),
  });
  await lockVault(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Password", { exact: true }).waitFor();
  if (offline)
    assert.equal(
      await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      true,
    );
  await unlockWithPassword(page);
  await list(page, width);
  await page.getByText(`${realName}.secret`, { exact: true }).first().waitFor();
}

try {
  for (const width of [390, 1280]) {
    const { page, context } = await harness.newPage(browser, {
      device:
        width === 390
          ? phoneContext({ width, height: 844 })
          : { viewport: { width, height: 800 } },
    });
    currentPage = page;
    await observeNativeContextMenu(page);
    const reject = `old-reject-${width}-long-password`;
    const synthetic = `old-synthetic-${width}-long-password`;
    const realName = `Production secret ${width}`;
    const prefix = `${width}${offline ? "-offline" : ""}`;
    console.log(`START retired credential UI ${width}px`);
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await harness.settleFirstLoad?.(page);
    await sealWithPassword(page);
    console.log(`SEALED ${width}px`);
    await visit(page, "vault/new");
    await page.getByLabel("Name", { exact: true }).fill(realName);
    await page
      .getByLabel("Secret value", { exact: true })
      .fill("real-secret-do-not-disclose");
    await page.getByRole("button", { name: "Save item" }).first().click();
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith(`${base}vault/`) &&
        !url.pathname.endsWith("/new"),
    );
    await manage(page);
    console.log(`MANAGE ${width}px`);
    assert.equal(
      await page.getByRole("radio", { name: "Record and reject" }).isChecked(),
      true,
    );
    await enroll(page, PASSWORD);
    console.log(`COLLISION ${width}px`);
    await expect(
      page.getByLabel("Current vault password", { exact: true }),
    ).toHaveValue("");
    await page.getByText("0 of 3", { exact: true }).waitFor();
    await enroll(page, reject);
    await page.getByText("1 of 3", { exact: true }).waitFor();
    console.log(`REJECT ENROLLED ${width}px`);
    await enroll(page, synthetic, true);
    await page.getByText("2 of 3", { exact: true }).waitFor();
    console.log(`SYNTHETIC ENROLLED ${width}px`);
    await page.screenshot({ path: path.join(out, `${prefix}-enrolled.png`) });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    if (width === 1280) await assertTrustedShiftMenu(page, context, false);
    await lockVault(page);
    console.log(`LOCKED ${width}px`);
    if (offline) {
      await context.setOffline(true);
      const cdp = await context.newCDPSession(page);
      await cdp.send("ServiceWorker.enable");
      await cdp.send("ServiceWorker.stopAllWorkers");
      await cdp.detach();
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByLabel("Password", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
        true,
      );
    }
    await attempt(page, reject);
    console.log(`REJECT ATTEMPTED ${width}px`);
    await page.waitForTimeout(1500);
    assert.equal(
      await page.getByLabel("Password", { exact: true }).isVisible(),
      true,
    );
    assert.equal(
      (await page.locator("body").innerText()).includes(realName),
      false,
    );
    // Establish the owner witness after the deliberate normal lock/reject.
    const ownerWitness = width === 1280 ? await context.newPage() : null;
    let realItemId;
    if (ownerWitness) {
      await ownerWitness.goto(`${origin}${base}vault`, {
        waitUntil: "domcontentloaded",
      });
      await ownerWitness.getByLabel("Password", { exact: true }).waitFor();
      await unlockWithPassword(ownerWitness);
      await list(ownerWitness, width);
      realItemId = await assertOwnerWitnessReadable(ownerWitness, realName);
      await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    }
    await attempt(page, synthetic);
    console.log(`SYNTHETIC ATTEMPTED ${width}px`);
    await waitOpen(page);
    await list(page, width);
    await assertSyntheticItems(page, realName);
    if (ownerWitness) {
      await list(ownerWitness, width);
      assert.equal(
        await assertOwnerWitnessReadable(ownerWitness, realName),
        realItemId,
      );
      await ownerWitness.close();
    }
    if (width === 1280) {
      const href = await assertTrustedShiftMenu(page, context, true);
      await assertFreshDocumentSealed(context, href, realName, realItemId);
      await assertOpenerDocumentSealed(page, href, realName, realItemId);
      await assertSyntheticItems(page, realName);
    }
    await page.screenshot({ path: path.join(out, `${prefix}-synthetic.png`) });
    await assertSyntheticNavigation(page, context);
    await page.screenshot({
      path: path.join(out, `${prefix}-synthetic-detail.png`),
    });
    await lockVault(page);
    // Public synthetic lock must preserve the original project's boot boundary.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByLabel("Password", { exact: true }).waitFor();
    if (offline)
      assert.equal(
        await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
        true,
      );
    await unlockWithPassword(page);
    await list(page, width);
    await page
      .getByText(`${realName}.secret`, { exact: true })
      .first()
      .waitFor();
    // Repeat only after fresh original-owner recovery: cold synthetic → real → synthetic.
    await coldReplay(page, context, width, synthetic, realName, prefix);
    await manage(page);
    await page
      .getByText(/Retired password observed/)
      .first()
      .waitFor();
    assert.equal(await page.getByText(/Retired password observed/).count(), 3);
    await page.screenshot({
      path: path.join(out, `${prefix}-observations.png`),
    });
    results.push({
      width,
      offline,
      installedWorkerStoppedBeforeOfflineReload: offline,
      result: "passed",
      checks: [
        "fresh owner authentication",
        "current-password collision refused",
        "record-and-reject default",
        "retired password rejected",
        "synthetic decoy opens",
        "production item absent from decoy",
        ...(width === 1280
          ? [
              "genuine owner Shift-contextmenu remains native",
              "genuine synthetic Shift-contextmenu is cancelled",
              "independently opened application document requires real authentication and exposes no privileged vault tools",
              "opener-created application document inherits only a sealed restriction and no real authority; parent remains synthetic",
              "independently authenticated owner tab can still reveal its real item after retired replay",
            ]
          : []),
        "synthetic account outbound link has no browser destination",
        "public synthetic lock and normal reload restore the original project",
        "fresh owner authentication restores the production item",
        "same retired credential opens only synthetic data after a second cold reload",
        "second synthetic outbound operation denied",
        "second fresh owner recovery preserves the original production item",
        "exactly three bounded local observations visible",
      ],
    });
    console.log(
      `PASS retired credential UI ${width}px${offline ? " offline service worker" : ""}`,
    );
    await context.close();
  }
  assert.deepEqual(
    harness.log.filter((event) => event.kind === "PAGE-ERROR"),
    [],
  );
  gate = "passed";
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({
      path: path.join(out, offline ? "offline-failure.png" : "failure.png"),
    });
    fs.writeFileSync(
      path.join(out, offline ? "offline-failure.txt" : "failure.txt"),
      await currentPage.locator("body").innerText(),
    );
  }
  throw error;
} finally {
  await browser.close();
  await harness.close?.();
  fs.writeFileSync(
    path.join(out, offline ? "offline-results.json" : "results.json"),
    `${JSON.stringify({ gate, buildIndexSha256, cases: results, pageErrors: harness.log.filter((event) => event.kind === "PAGE-ERROR") }, null, 2)}\n`,
  );
}
