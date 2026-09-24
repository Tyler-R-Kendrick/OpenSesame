// Tailnet vault sync, end to end (ADR 0140): a real `opensesame` daemon as
// the drive, and two devices that share nothing but the pairing code.
//
//   cargo build -p opensesame-cli
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
//     pnpm --filter @opensesame/pages verify:tailnet-sync
//
// The daemon listens on loopback (a drive address pairing accepts) with a
// throwaway slot directory. Each device is its own browser context — its own
// storage, as separate as two phones — served `dist/` under the production
// origin; the only other address either may reach is the drive.
//
//   TS-PAIR    device A seals a vault with a password, saves an item, turns
//              Networking on and pairs: the panel reports it in step and the
//              drive holds generation ≥ 1 of a snapshot it cannot read
//   TS-ADOPT   device B, a guest, opens the pairing link: the code arrives
//              from the fragment and leaves the address bar, pressing the
//              key hands over to an unlock screen, and A's master password
//              opens A's item
//   TS-BACK    B saves an item; A, syncing, shows it
//
// Screenshots land in $TAILNET_SYNC_OUT (default: the system temp dir).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { sealWithPassword, unlockWithPassword } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const base = "/OpenSesame/";
const port = Number(process.env.TAILNET_SYNC_PORT ?? 18791);
const drive = `http://127.0.0.1:${port}`;
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const binary = path.join(repo, "target/debug/opensesame");
const out =
  process.env.TAILNET_SYNC_OUT ??
  fs.mkdtempSync(path.join(os.tmpdir(), "tailnet-sync-"));
const slots = fs.mkdtempSync(path.join(os.tmpdir(), "vault-drive-"));
const operator = `verify-${crypto.randomUUID()}${crypto.randomUUID()}`;
const harness = createHarness({
  dist: fileURLToPath(new URL("../dist", import.meta.url)),
  origin,
  base,
  out: path.join(out, ".log"),
});

function startDrive() {
  const daemon = spawn(
    binary,
    ["daemon", "run", "--listen", `127.0.0.1:${port}`],
    {
      env: {
        ...process.env,
        OPENSESAME_OPERATOR_TOKEN: operator,
        OPENSESAME_CORS_ORIGINS: origin,
        OPENSESAME_VAULT_DRIVE_DIR: slots,
        OPENSESAME_DAEMON_NETWORK_BRIDGE: "0",
        OPENSESAME_ENV: "development",
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  return daemon;
}

async function until(check, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function openSlot() {
  const response = await fetch(`${drive}/v1/vault-drive/slots`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opensesame-operator": operator,
    },
    body: JSON.stringify({ label: "Verify drive", url: drive }),
  });
  if (response.status !== 201) throw new Error(`slot: ${response.status}`);
  return (await response.json()).pairing_code;
}

async function readSlot(code) {
  const pairing = JSON.parse(
    Buffer.from(code.split(":").at(-1), "base64url").toString(),
  );
  const response = await fetch(
    `${drive}/v1/vault-drive/slots/${pairing.slot}/snapshot`,
    { headers: { authorization: `Bearer ${pairing.key}` } },
  );
  return response.json();
}

/** A device: the harness page, allowed to reach the drive and nothing else. */
async function device(browser, options) {
  const { page, context } = await harness.newPage(browser, options);
  await context.route(`${drive}/**`, (route) => route.continue());
  // A person answers Chrome's local-network prompt once; headless cannot.
  pages.push(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  return { page, context, errors };
}

async function visit(page, route) {
  await page.evaluate((href) => {
    history.pushState(null, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
  await page.waitForTimeout(1200);
}

async function networkingOn(page) {
  await visit(page, "settings/capabilities");
  await page.getByRole("switch", { name: "Networking", exact: true }).click();
  await page.getByTestId("capability-apply").click();
  await page
    .getByTestId("capability-review")
    .waitFor({ state: "detached", timeout: 20_000 });
}

async function saveItem(page, name) {
  await visit(page, "vault");
  await page
    .getByRole("link", { name: "New item", exact: true })
    .first()
    .click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  const save = page.getByRole("button", { name: "Save item", exact: true });
  await save.first().scrollIntoViewIfNeeded();
  await save.first().click();
  await page.waitForTimeout(900);
}

async function inStep(page) {
  const mark = page.locator("#tailnet-sync .status-mark");
  await expect(mark).toHaveAttribute("aria-label", /^In step at /, {
    timeout: 20_000,
  });
}

async function shot(page, name) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${file}`);
}

const daemon = startDrive();
// Chrome asks a person before a public page reaches a local address (Local
// Network Access); headless has nobody to ask, so the check is switched off.
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  headless: true,
  args: [
    "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
  ],
});
const pages = [];
let failed = false;
try {
  await until(async () => (await fetch(`${drive}/health`)).ok, "the drive");
  const code = await openSlot();

  // TS-PAIR
  const a = await device(browser, {
    device: { viewport: { width: 1280, height: 900 } },
  });
  await sealWithPassword(a.page);
  await saveItem(a.page, "Bank of Example");
  await networkingOn(a.page);
  await visit(a.page, "settings/vaults");
  await a.page.getByLabel("Pairing code", { exact: true }).fill(code);
  await a.page.getByRole("button", { name: "Pair with this drive" }).click();
  await inStep(a.page);
  const stored = await readSlot(code);
  if (!(stored.generation >= 1)) throw new Error("TS-PAIR: drive is empty");
  if (JSON.stringify(stored).includes("Bank of Example"))
    throw new Error("TS-PAIR: the drive can read an item name");
  console.log(`TS-PAIR ok (generation ${stored.generation})`);
  await shot(a.page, "1280-device-a-paired");

  // TS-ADOPT
  const b = await device(browser, {
    device: phoneContext({ width: 390, height: 844 }),
  });
  await b.page
    .getByRole("button", { name: "Continue as guest", exact: true })
    .tap();
  await b.page.waitForTimeout(1400);
  await networkingOn(b.page);
  await visit(b.page, `settings/vaults#pair-drive=${code}`);
  await expect(b.page.getByLabel("Pairing code", { exact: true })).toHaveValue(
    code,
  );
  if (b.page.url().includes("pair-drive"))
    throw new Error("TS-ADOPT: the code stayed in the address bar");
  await shot(b.page, "390-device-b-link");
  await b.page
    .getByRole("button", { name: "Set this device up from the drive" })
    .tap();
  await b.page
    .getByLabel("Password", { exact: true })
    .waitFor({ timeout: 20_000 });
  await shot(b.page, "390-device-b-unlock");
  await unlockWithPassword(b.page);
  await visit(b.page, "vault");
  await expect(b.page.getByText("Bank of Example").first()).toBeVisible({
    timeout: 20_000,
  });
  console.log("TS-ADOPT ok");
  await shot(b.page, "390-device-b-vault");

  // TS-BACK
  await saveItem(b.page, "Saved on the phone");
  await visit(b.page, "settings/vaults");
  await inStep(b.page);
  await shot(b.page, "390-device-b-in-step");
  await visit(a.page, "settings/vaults");
  await a.page.getByRole("button", { name: "Sync now" }).click();
  await inStep(a.page);
  await visit(a.page, "vault");
  await expect(a.page.getByText("Saved on the phone").first()).toBeVisible({
    timeout: 20_000,
  });
  console.log("TS-BACK ok");
  await shot(a.page, "1280-device-a-received");

  const errors = [...a.errors, ...b.errors];
  if (errors.length > 0) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log("verify:tailnet-sync PASS");
} catch (error) {
  failed = true;
  console.error(`verify:tailnet-sync FAIL — ${error.stack ?? error}`);
  for (const [n, page] of pages.entries()) {
    await shot(page, `failure-${n}`).catch(() => undefined);
    const panel = await page
      .locator("#tailnet-sync")
      .innerText()
      .catch(() => "(no panel)");
    console.error(`device ${n} at ${page.url()}: ${panel}`);
  }
} finally {
  await browser.close();
  daemon.kill();
  fs.rmSync(slots, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
