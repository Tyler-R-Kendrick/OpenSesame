// Tailnet vault sync, end to end (ADR 0144): a real `opensesame` daemon as
// the drive, and two devices that share nothing but the pairing code.
//
//   cargo build -p opensesame-cli
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
//     pnpm --filter @opensesame/pages verify:tailnet-sync
//
// The daemon listens on loopback with a throwaway slot directory, and is
// reached the way Tailscale Serve exposes it: HTTPS at a `*.ts.net` name,
// through a TLS proxy in front of it (`lib/tailscale-serve-drive.mjs`). Each
// device is its own browser context — its own storage, as separate as two
// phones — served `dist/` under the production origin; the only other address
// either may reach is the drive.
//
// Chrome's Local Network Access check stays on, as in a person's browser: the
// page is public and the drive resolves to a private address, so a request
// waits on the permission prompt until it is answered. Headless Chrome shows
// no prompt, so each device's answer is set through the DevTools protocol.
//
// TAILNET_SYNC_TAILNET=<name>,<tls port>,<100.x address> runs the same walk
// over a real tailnet instead (scripts/test/tailnet-sync-real-tailnet.sh).
//
//   TS-PAIR    device A seals a vault with a password, saves an item, turns
//              Networking on and pairs (the row's key opens the pairing
//              sheet, the code goes in the sheet, its commit pairs): the panel
//              reports it in step and the drive holds generation ≥ 1 of a
//              snapshot it cannot read
//   TS-ADOPT   device B, a guest, opens the pairing link: the sheet opens with
//              the code from the fragment filled in and gone from the address
//              bar, pressing the sheet's commit hands over to an unlock
//              screen, and A's master password opens A's item
//   TS-BACK    B saves an item; A, syncing, shows it
//   LNA-WAIT   A's permission back at "ask": a change on A does not go out by
//              itself and the panel says sync waits on the browser; once
//              allowed, Sync now lands it
//   LNA-DENIED device C refused local network access: the browser itself
//              refuses a request to the drive, and pairing says where to
//              allow it
//
// Screenshots land in $TAILNET_SYNC_OUT (default: the system temp dir).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { doorGuest } from "./lib/front-door.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { sealWithPassword, unlockWithPassword } from "./lib/pages-journey.mjs";
import { toTheList } from "./lib/phone-vault.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { tailscaleServeDrive } from "./lib/tailscale-serve-drive.mjs";

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
    body: JSON.stringify({ label: "Verify drive", url: serve.url }),
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

/** How a person answered Chrome's local-network prompt for this device. */
async function answerPrompt(page, setting) {
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  await browserSession.send("Browser.setPermission", {
    permission: { name: "local-network-access" },
    setting,
    origin,
    browserContextId: targetInfo.browserContextId,
  });
}

/** Whether the browser itself lets the page reach the drive. */
function browserReaches(page) {
  return page.evaluate(async (url) => {
    try {
      // Opaque: whether the request went out, not what CORS lets it read.
      const signal = AbortSignal.timeout(3000);
      await fetch(`${url}/health`, { signal, mode: "no-cors" });
      return true;
    } catch {
      return false;
    }
  }, serve.url);
}

/** A device: the harness page, allowed to reach the drive and nothing else. */
async function device(browser, options, answer = "granted") {
  const { page, context } = await harness.newPage(browser, {
    ...options,
    device: { ...options.device, ignoreHTTPSErrors: true },
  });
  await context.route(`${serve.url}/**`, (route) => route.continue());
  await answerPrompt(page, answer);
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
  await page
    .getByTestId("capability-review")
    .waitFor({ state: "detached", timeout: 20_000 });
}

async function saveItem(page, name) {
  await visit(page, "vault");
  await toTheList(page);
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

/** `<MagicDNS name>,<port Serve forwards 443 to>,<the drive node's address>` */
function tailnetFromEnv() {
  const raw = process.env.TAILNET_SYNC_TAILNET;
  if (!raw) return null;
  const [host, tlsPort, address] = raw.split(",");
  return { host, tlsPort, address };
}

const daemon = startDrive();
const tailnet = tailnetFromEnv();
const serve = await tailscaleServeDrive(drive, tailnet);
console.log(
  tailnet
    ? `drive ${serve.url}: over the tailnet to ${tailnet.address}, Serve → 127.0.0.1:${tailnet.tlsPort}`
    : `drive ${serve.url}: resolved to the TLS proxy on loopback`,
);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  headless: true,
  args: serve.browserArgs,
});
const browserSession = await browser.newBrowserCDPSession();
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
  // Pairing is a ceremony in a sheet: the row's key opens it, the code goes
  // in the sheet, and the sheet's commit pairs.
  await a.page
    .getByRole("button", { name: "Pair with a drive", exact: true })
    .click();
  const pairSheet = a.page.getByRole("dialog");
  await pairSheet.getByLabel("Pairing code", { exact: true }).fill(code);
  await pairSheet
    .getByRole("button", { name: "Pair with this drive", exact: true })
    .click();
  await pairSheet.waitFor({ state: "detached", timeout: 20_000 });
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
  await doorGuest(b.page).tap();
  await b.page.waitForTimeout(1400);
  await networkingOn(b.page);
  await visit(b.page, `settings/vaults#pair-drive=${code}`);
  // The link opens the sheet by itself with the code already in the field.
  const linkSheet = b.page.getByRole("dialog");
  await expect(
    linkSheet.getByLabel("Pairing code", { exact: true }),
  ).toHaveValue(code);
  if (b.page.url().includes("pair-drive"))
    throw new Error("TS-ADOPT: the code stayed in the address bar");
  await shot(b.page, "390-device-b-link");
  // The row's key carries the same name as the sheet's commit; the commit is
  // the one inside the dialog.
  await linkSheet
    .getByRole("button", {
      name: "Set this device up from the drive",
      exact: true,
    })
    .tap();
  await b.page
    .getByLabel("Password", { exact: true })
    .waitFor({ timeout: 20_000 });
  await shot(b.page, "390-device-b-unlock");
  await unlockWithPassword(b.page);
  await visit(b.page, "vault");
  // A phone opens the vault on the section tree; the item is two panes in.
  await toTheList(b.page);
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

  // LNA-WAIT
  await answerPrompt(a.page, "prompt");
  const before = (await readSlot(code)).generation;
  await saveItem(a.page, "Waiting on the browser");
  await visit(a.page, "settings/vaults");
  await expect(a.page.locator("#tailnet-sync .status-mark")).toHaveAttribute(
    "aria-label",
    /waiting for local network access/,
    { timeout: 20_000 },
  );
  if ((await readSlot(code)).generation !== before)
    throw new Error("LNA-WAIT: a pass went out past the browser's prompt");
  await shot(a.page, "1280-device-a-waiting");
  await answerPrompt(a.page, "granted");
  await a.page.getByRole("button", { name: "Sync now" }).click();
  await inStep(a.page);
  if (!((await readSlot(code)).generation > before))
    throw new Error("LNA-WAIT: Sync now did not land the change");
  console.log("LNA-WAIT ok");

  // LNA-DENIED
  const c = await device(
    browser,
    { device: { viewport: { width: 1280, height: 900 } } },
    "denied",
  );
  if (await browserReaches(c.page))
    throw new Error("LNA-DENIED: the browser let a refused page through");
  if (!(await browserReaches(a.page)))
    throw new Error("LNA-DENIED: an allowed page could not reach the drive");
  await doorGuest(c.page).click();
  await c.page.waitForTimeout(1400);
  await networkingOn(c.page);
  await visit(c.page, `settings/vaults#pair-drive=${code}`);
  const refused = c.page.getByRole("dialog");
  await refused
    .getByRole("button", {
      name: "Set this device up from the drive",
      exact: true,
    })
    .click();
  await expect(
    refused.getByRole("alert").locator(".status-mark"),
  ).toHaveAttribute("aria-label", /Allow local network access for this site/, {
    timeout: 20_000,
  });
  await shot(c.page, "1280-device-c-denied");
  console.log("LNA-DENIED ok");

  const errors = [...a.errors, ...b.errors, ...c.errors];
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
    const marks = await page
      .locator(".status-mark")
      .evaluateAll((all) => all.map((mark) => mark.getAttribute("aria-label")))
      .catch(() => []);
    console.error(`device ${n} at ${page.url()}: ${panel}`);
    console.error(`device ${n} marks: ${marks.join(" | ")}`);
  }
} finally {
  await browser.close();
  serve.close();
  daemon.kill();
  fs.rmSync(slots, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
