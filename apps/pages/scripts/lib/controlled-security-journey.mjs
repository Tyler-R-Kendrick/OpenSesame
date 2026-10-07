/** Public UI ceremonies and cold offline recovery, without source-port replacements. */
import assert from "node:assert/strict";
import path from "node:path";
import { expect } from "@playwright/test";
import {
  downloadCanary,
  proveIndependentDetector,
} from "./controlled-security-processes.mjs";
import { observeSealedRequests } from "./controlled-security-wire.mjs";
import { lockVault, waitOpen } from "./pages-journey.mjs";
import {
  SEEDED_PASSWORD as PASSWORD,
  seedPasswordVault,
  unlockSeeded,
} from "./seeded-vault.mjs";

async function visit(page, base, route) {
  await page.evaluate((pathname) => {
    history.pushState({}, "", pathname);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
}

export async function openDialog(page, base, button) {
  await visit(page, base, "settings/security");
  await page.getByRole("button", { name: button, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Current vault password", { exact: true }).waitFor();
  return dialog;
}

async function closeDialog(dialog) {
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}

export async function ownerAction(dialog, name) {
  await dialog
    .getByLabel("Current vault password", { exact: true })
    .fill(PASSWORD);
  const button = dialog.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(
    dialog.getByLabel("Current vault password", { exact: true }),
  ).toHaveValue("");
}

export async function createRealItem(page, base, realName) {
  // Controlled-canary management targets an explicit legacy password vault.
  await seedPasswordVault(page.context(), new URL(page.url()).origin);
  await page.reload({ waitUntil: "networkidle" });
  await unlockSeeded(page);
  await visit(page, base, "vault/new");
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
}

async function configureReceiver(page, context, base, receiver, out, width) {
  const dialog = await openDialog(page, base, "Manage observation receiver");
  await dialog
    .getByLabel("Receiver pairing file", { exact: true })
    .setInputFiles(receiver.pairingFile);
  await dialog.getByText(receiver.origin, { exact: true }).waitFor();
  await ownerAction(dialog, "Confirm receiver destination");
  await dialog.getByText("Not tested", { exact: true }).waitFor();
  await dialog
    .getByLabel("Current vault password", { exact: true })
    .fill(PASSWORD);
  await expect(
    dialog.getByRole("button", {
      name: "Enable observation receiver",
      exact: true,
    }),
  ).toBeDisabled();
  await context.addCookies([
    {
      url: receiver.origin,
      name: "observation-cookie-fixture",
      value: "public-fixture",
    },
  ]);
  await ownerAction(dialog, "Test observation receiver");
  await dialog
    .getByText("Receiver acknowledged sealed delivery.", { exact: true })
    .waitFor();
  await dialog
    .getByText("Authenticated acknowledgement received", { exact: true })
    .waitFor();
  const receipts = await receiver.receipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].metadata.event.type, "receiver_test");
  await ownerAction(dialog, "Enable observation receiver");
  await dialog
    .getByRole("button", { name: "Disable observation receiver", exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(out, `${width}-receiver-verified.png`),
  });
  await closeDialog(dialog);
}

async function enrollSynthetic(page, base, retired) {
  const dialog = await openDialog(page, base, "Manage retired passwords");
  await dialog
    .getByLabel("Current vault password", { exact: true })
    .fill(PASSWORD);
  await dialog
    .getByLabel("Selected retired password", { exact: true })
    .fill(retired);
  await dialog.getByRole("radio", { name: "Open a synthetic decoy" }).check();
  await dialog
    .getByRole("checkbox", { name: /retaining a password-only verifier/ })
    .check();
  await dialog
    .getByRole("button", { name: "Enroll retired password", exact: true })
    .click();
  await dialog.getByText("1 of 3", { exact: true }).waitFor();
  await closeDialog(dialog);
}

async function showItems(page, base, width) {
  await visit(page, base, "vault");
  if (width === 390) {
    await page
      .getByRole("treeitem", { name: /^all\b/i })
      .first()
      .click();
    await page.locator(".vault[data-pane='list']").waitFor();
  }
}

async function enterSynthetic(page, base, width, retired, realName) {
  await page.getByLabel("Password", { exact: true }).fill(retired);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
  await showItems(page, base, width);
  await page
    .getByText("Example account.account", { exact: true })
    .first()
    .waitFor();
  const text = await page.locator("body").innerText();
  assert.equal(text.includes(realName), false);
  assert.equal(text.includes("real-secret-do-not-disclose"), false);
  await visit(page, base, "settings/security");
  assert.equal(
    await page
      .getByRole("button", { name: "Manage controlled canaries", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Manage observation receiver", exact: true })
      .count(),
    0,
  );
}

async function coldReload(page, context) {
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

async function proveColdRecovery(
  page,
  context,
  base,
  width,
  retired,
  realName,
) {
  await lockVault(page);
  await context.setOffline(true);
  await coldReload(page, context);
  await unlockSeeded(page);
  await showItems(page, base, width);
  await page.getByText(`${realName}.secret`, { exact: true }).first().waitFor();
  await lockVault(page);
  await coldReload(page, context);
  await enterSynthetic(page, base, width, retired, realName);
  await lockVault(page);
  await coldReload(page, context);
  await unlockSeeded(page);
  await showItems(page, base, width);
  await page.getByText(`${realName}.secret`, { exact: true }).first().waitFor();
  await context.setOffline(false);
}

export async function controlledSecurityJourney({
  page,
  context,
  base,
  width,
  directory,
  receiver,
  out,
}) {
  const realName = `Private owner item ${width}`;
  const retired = `controlled-retired-${width}-long-password`;
  await createRealItem(page, base, realName);
  const dialog = await openDialog(page, base, "Manage controlled canaries");
  const { file, config } = await downloadCanary(page, dialog, directory);
  await dialog.getByText("Artifact exported", { exact: false }).waitFor();
  await page.screenshot({
    path: path.join(out, `${width}-canary-exported.png`),
  });
  await closeDialog(dialog);
  const wireProof = observeSealedRequests(page, receiver, [
    retired,
    config.artifact.presentedId,
    realName,
    "real-secret-do-not-disclose",
  ]);
  const detector = await proveIndependentDetector(
    directory,
    file,
    config,
    realName,
  );
  console.log(`DETECTOR PASS ${width}px`);
  await configureReceiver(page, context, base, receiver, out, width);
  console.log(`RECEIVER ACK PASS ${width}px`);
  await enrollSynthetic(page, base, retired);
  await lockVault(page);
  await enterSynthetic(page, base, width, retired, realName);
  await expect
    .poll(async () =>
      (await receiver.receipts()).some(
        (receipt) =>
          receipt.metadata.event.type === "retired_credential_observed",
      ),
    )
    .toBe(true);
  const receipts = await receiver.receipts();
  for (const forbidden of [
    retired,
    config.artifact.presentedId,
    realName,
    "real-secret-do-not-disclose",
  ])
    assert.equal(JSON.stringify(receipts).includes(forbidden), false);
  await page.screenshot({
    path: path.join(out, `${width}-synthetic-observation.png`),
  });
  await proveColdRecovery(page, context, base, width, retired, realName);
  console.log(`COLD RECOVERY PASS ${width}px`);
  return {
    width,
    detector,
    wire: await wireProof(),
    receiver: {
      genuineAcknowledgement: true,
      cookiesOmitted: true,
      retiredMatchReceivedWhileSynthetic: true,
      eventTypes: receipts.map((receipt) => receipt.metadata.event.type),
    },
    offlineColdReplay: true,
    originalOwnerRecoveredTwice: true,
  };
}
