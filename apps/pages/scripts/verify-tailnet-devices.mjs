// Tailnet device management, end to end (ADR 0166): a real `opensesame`
// daemon holding the tailnet credential, a stand-in for api.tailscale.com
// (`lib/tailscale-stub.mjs`), and the built page, which never sees the
// credential.
//
//   cargo build -p opensesame-cli --features tailnet-admin-test-upstream
//   VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build:live-dedicated
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
//     pnpm --filter @opensesame/pages verify:tailnet-devices
//
// The page is the deployment of one's own (`dedicated_origin`): the shared
// GitHub Pages origin may not hold tailnet authority at all, and says so
// (TD-SHARED, against `dist/` when it is there). The daemon runs on loopback with a throwaway state directory and the stub
// as its Tailscale API (`OPENSESAME_TAILSCALE_API_BASE`, read only by a build
// with that feature). The operator side is the CLI a person runs: `daemon
// tailnet connect`, `pair`, `unpair`. Each browser is its own context, served
// `dist/` under the production origin.
//
//   TD-PAIR     an owner opens the link `pair` printed: the sheet opens with
//               the code, the commit pairs, and the tailnet's four machines
//               are listed, the one waiting for approval first
//   TD-APPROVE  approving it reaches Tailscale, and its mark goes
//   TD-EDIT     a rename, a tag and the exit node, saved together, reach
//               Tailscale as three calls; a tag the policy does not own is
//               refused with Tailscale's words
//   TD-ADD      Add a device mints a pre-approved, tagged auth key; a machine
//               joins with it and is listed, tagged and approved
//   TD-EXPIRE   expiring a key, revoking an auth key and removing a machine
//               each take two presses and each reach Tailscale
//   TD-AUDIT    the Activity list and the daemon's own log name each change
//               and the pairing that made it; no credential or auth key is in
//               the daemon's state, the page's storage or the log
//   TD-READ     a phone paired read-only sees the same tailnet and holds no
//               key that changes it; `unpair --all` cuts it off
//   TD-FORGET   the owner forgets the pairing; the panel offers pairing only
//
// Screenshots land in $TAILNET_DEVICES_OUT (default: the system temp dir).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { dedicatedSite } from "./lib/live-dedicated.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { sealWithPassword } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import {
  approve,
  editPangolin,
  mintAndJoin,
  removeAndRevoke,
} from "./lib/tailnet-devices-steps.mjs";
import {
  API_TOKEN,
  TAILNET,
  startTailscaleStub,
} from "./lib/tailscale-stub.mjs";

const { origin, dist } = dedicatedSite();
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const port = Number(process.env.TAILNET_DEVICES_PORT ?? 18792);
const daemonUrl = `http://127.0.0.1:${port}`;
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const binary = path.join(repo, "target/debug/opensesame");
const out =
  process.env.TAILNET_DEVICES_OUT ??
  fs.mkdtempSync(path.join(os.tmpdir(), "tailnet-devices-"));
const state = fs.mkdtempSync(path.join(os.tmpdir(), "tailnet-admin-"));
const harness = createHarness({
  dist,
  origin,
  base,
  out: path.join(out, ".log"),
});
const stub = await startTailscaleStub();
const env = {
  ...process.env,
  OPENSESAME_TAILNET_ADMIN_DIR: state,
  OPENSESAME_TAILSCALE_API_BASE: stub.base,
  OPENSESAME_OPERATOR_TOKEN: `verify-${crypto.randomUUID()}${crypto.randomUUID()}`,
  OPENSESAME_DAEMON_NETWORK_BRIDGE: "0",
  OPENSESAME_ENV: "development",
};

/** The CLI a person runs on the daemon's machine. */
function cli(...args) {
  return execFileSync(binary, ["daemon", "tailnet", ...args], {
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function pairLink(role, label) {
  const printed = cli(
    "pair",
    "--origin",
    origin,
    "--role",
    role,
    "--url",
    daemonUrl,
    "--label",
    label,
    "--pages-url",
    `${origin}${base}`,
    "--no-qr",
  );
  const link = printed.match(/^link\s+(\S+)$/m)?.[1];
  if (!link) throw new Error(`pair printed no link:\n${printed}`);
  return link;
}

async function until(check, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const pages = [];
async function browserPage(browser, options) {
  const { page, context } = await harness.newPage(browser, options);
  await context.route(`${daemonUrl}/**`, (route) => route.continue());
  pages.push(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  return { page, errors };
}

async function visit(page, route) {
  await page.evaluate((href) => {
    history.pushState(null, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
  await page.waitForTimeout(1200);
}

/** Identity (the section the panel is in), then Networking (the panel). */
async function deviceManagementOn(page) {
  await visit(page, "settings/capabilities");
  for (const name of ["Identity", "Networking"]) {
    const toggle = page.getByRole("switch", { name, exact: true });
    if ((await toggle.getAttribute("aria-checked")) === "true") continue;
    await toggle.click();
    await page
      .getByTestId("capability-review")
      .waitFor({ state: "detached", timeout: 20_000 });
  }
}

/** Open the printed link and press the sheet's commit. */
async function pairByLink(page, link) {
  const fragment = new URL(link).hash;
  await visit(page, `identity?view=devices${fragment}`);
  const sheet = page.getByRole("dialog", {
    name: "Pair with the tailnet daemon",
  });
  await expect(sheet.getByLabel("Pairing code", { exact: true })).toHaveValue(
    /^opensesame-tailnet:v1:/,
  );
  if (page.url().includes("pair-tailnet"))
    throw new Error("the code stayed in the address bar");
  await sheet
    .getByRole("button", { name: "Pair with this daemon", exact: true })
    .click();
  await sheet.waitFor({ state: "detached", timeout: 20_000 });
}

async function shot(page, name) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  ${file}`);
}

/**
 * The daemon's state, but its credential file: the one file the API token may
 * be in (0600 in a 0700 directory). Nothing else it writes holds a token, a
 * minted key or a bearer.
 */
function stateFiles() {
  const secret = path.join(state, "tailnet-admin.secret");
  if ((fs.statSync(secret).mode & 0o077) !== 0)
    throw new Error("the credential file is readable by others");
  if ((fs.statSync(state).mode & 0o077) !== 0)
    throw new Error("the state directory is open to others");
  return fs
    .readdirSync(state)
    .filter((name) => name !== "tailnet-admin.secret")
    .map((name) => fs.readFileSync(path.join(state, name), "utf8"))
    .join("\n");
}

const secretFile = path.join(state, "..", `tailnet-token-${process.pid}`);
fs.writeFileSync(secretFile, `${API_TOKEN}\n`, { mode: 0o600 });
cli(
  "connect",
  "--tailnet",
  TAILNET,
  "--api-token",
  "--secret-file",
  secretFile,
);
fs.rmSync(secretFile);
const daemon = spawn(
  binary,
  ["daemon", "run", "--listen", `127.0.0.1:${port}`],
  { env, stdio: ["ignore", "ignore", "inherit"] },
);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  headless: true,
  args: [
    "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
  ],
});
let failed = false;
try {
  await until(async () => (await fetch(`${daemonUrl}/health`)).ok, "daemon");

  // TD-PAIR
  const owner = await browserPage(browser, {
    device: { viewport: { width: 1280, height: 900 } },
  });
  const page = owner.page;
  await sealWithPassword(page);
  await deviceManagementOn(page);
  await pairByLink(page, pairLink("manage", "Ops laptop"));
  const rows = page
    .getByRole("region", { name: "Tailnet devices" })
    .getByRole("heading", { level: 3 });
  await expect(rows).toHaveCount(4, { timeout: 20_000 });
  await expect(rows.first()).toHaveText("sams-phone");
  console.log("TD-PAIR ok");
  await shot(page, "1280-paired");

  const steps = { page, stub, shot, until };
  await approve(steps);
  await editPangolin(steps);
  const minted = await mintAndJoin(steps);
  await removeAndRevoke(steps);

  // TD-AUDIT
  const activity = page.getByRole("region", { name: "Tailnet activity" });
  for (const said of [
    "Approved sams-phone",
    "Renamed web-01",
    "Tagged web-01",
    "Changed routes of web-01",
    "Minted the auth key",
    "Revoked the auth key",
    "Removed",
  ])
    await expect(activity.getByText(said).first()).toBeVisible();
  const kept = stateFiles();
  if (!kept.includes("device.authorize") || !kept.includes("Ops laptop"))
    throw new Error("TD-AUDIT: the daemon's log is missing the approval");
  if (kept.includes(minted) || kept.includes(API_TOKEN) || /tskey-/.test(kept))
    throw new Error("TD-AUDIT: a key or credential is in the daemon's state");
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  if (stored.includes("tskey-")) throw new Error("TD-AUDIT: key in storage");
  console.log("TD-AUDIT ok");
  await shot(page, "1280-activity");

  // TD-READ
  const phone = await browserPage(browser, {
    device: phoneContext({ width: 390, height: 844 }),
  });
  await sealWithPassword(phone.page);
  await deviceManagementOn(phone.page);
  await pairByLink(phone.page, pairLink("read", "Help desk phone"));
  const phoneRows = phone.page
    .getByRole("region", { name: "Tailnet devices" })
    .getByRole("heading", { level: 3 });
  await expect(phoneRows.first()).toBeVisible({ timeout: 20_000 });
  for (const name of [/^Add a device$/, /^Approve /, /^Remove /, /^Revoke /])
    await expect(phone.page.getByRole("button", { name })).toHaveCount(0);
  await shot(phone.page, "390-read-only");
  cli("unpair", "--all");
  await phone.page
    .getByRole("button", { name: "Reload tailnet devices" })
    .click();
  await expect(phone.page.getByRole("alert")).toContainText(
    "no longer knows this page's key",
    { timeout: 20_000 },
  );
  console.log("TD-READ ok");
  await shot(phone.page, "390-unpaired");

  // TD-FORGET — the owner's pairing went with `--all`; forgetting it here
  // clears the sealed copy, and the panel offers pairing again.
  await page
    .getByRole("button", { name: "Forget this daemon's pairing" })
    .click();
  await page
    .getByRole("button", { name: "Confirm forgetting this daemon's pairing" })
    .click();
  await expect(
    page.getByRole("button", { name: "Pair with the tailnet daemon" }),
  ).toBeVisible({ timeout: 20_000 });
  console.log("TD-FORGET ok");

  const errors = [...owner.errors, ...phone.errors];
  if (errors.length > 0) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log("verify:tailnet-devices PASS");
} catch (error) {
  failed = true;
  console.error(`verify:tailnet-devices FAIL — ${error.stack ?? error}`);
  for (const [n, page] of pages.entries()) {
    await shot(page, `failure-${n}`).catch(() => undefined);
  }
  console.error(
    "Tailscale saw:",
    stub.tailnet.calls.map((c) => `${c.method} ${c.path}`).join("\n  "),
  );
} finally {
  await browser.close();
  daemon.kill();
  await stub.close();
  fs.rmSync(state, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
