// Visual evidence for the tailnet-sync follow-up (ADR 0144 items 11–18): the
// same three walks on the base build and on this branch's, at desktop and
// phone width, each with what the browser measured.
//
//   capture before|after <raw-dir>   one build's screenshots and measurements
//   compose <raw-dir> <evidence-dir> side-by-side sheets of the two
//
// Walks:
//   capabilities  Settings › Capabilities, scrolled to Environments and what
//                 follows it: the Breach and two-step checks section is new
//   checks        that capability on, two logins saved, Settings › Vaults,
//                 its key pressed: findings as glyphs (the two services are
//                 answered from fixtures, as the real ones answer)
//   waiting       a sealed, paired vault whose Local Network Access is still
//                 at "ask": what the Tailnet sync panel says after a change
//
// The drive is the real daemon behind the verifier's *.ts.net TLS proxy;
// nothing on the page is staged.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { doorGuest } from "./lib/front-door.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { sealWithPassword } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { tailscaleServeDrive } from "./lib/tailscale-serve-drive.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const base = "/OpenSesame/";
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const [mode, side, rawArg, outArg] = process.argv.slice(2);
const SHOP_PASSWORD = "a long unique passphrase for the shop";
const WIDTHS = {
  desktop: { viewport: { width: 1280, height: 900 } },
  phone: phoneContext({ width: 390, height: 844 }),
};

function sha1(text) {
  return createHash("sha1").update(text).digest("hex").toUpperCase();
}

/** The two services the check reaches, answered as they answer. */
function fixtures(dir) {
  const pwned = path.join(dir, "range-5BAA6.txt");
  // SHA-1("password") = 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8.
  fs.writeFileSync(pwned, "1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\n");
  const shop = path.join(dir, "range-shop.txt");
  fs.writeFileSync(shop, "0000000000000000000000000000000000A:0\r\n");
  const list = path.join(dir, "totp.json");
  fs.writeFileSync(
    list,
    JSON.stringify([["GitHub", { domain: "github.com", tfa: ["totp"] }]]),
  );
  return {
    "https://api.pwnedpasswords.com/range/5BAA6": pwned,
    [`https://api.pwnedpasswords.com/range/${sha1(SHOP_PASSWORD).slice(0, 5)}`]:
      shop,
    "https://api.2fa.directory/v3/totp.json": list,
  };
}

async function visit(page, route) {
  await page.evaluate((href) => {
    history.pushState(null, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
  await page.waitForTimeout(1500);
}

async function switchOn(page, name) {
  await visit(page, "settings/capabilities");
  const toggle = page.getByRole("switch", { name, exact: true });
  if (!(await toggle.count())) return false;
  await toggle.first().scrollIntoViewIfNeeded();
  await toggle.first().click();
  await page
    .getByTestId("capability-review")
    .waitFor({ state: "detached", timeout: 20_000 });
  return true;
}

async function saveLogin(page, name, password, address) {
  await visit(page, "vault/new/login");
  await page.getByLabel("Name", { exact: true }).first().fill(name);
  await page.getByLabel("Password", { exact: true }).first().fill(password);
  await page.getByLabel("Address 1", { exact: true }).first().fill(address);
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page.waitForTimeout(900);
}

async function marksIn(page, selector) {
  return page
    .locator(`${selector} .status-mark`)
    .evaluateAll((all) => all.map((mark) => mark.getAttribute("aria-label")));
}

async function capabilitiesWalk(page, shot) {
  await visit(page, "settings/capabilities");
  const anchor = page
    .locator(".conn-group", { hasText: "Environments" })
    .first();
  await anchor.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 120));
  const groups = await page.locator(".conn-group").count();
  const present = await page
    .getByText("Breach and two-step checks", { exact: true })
    .count();
  await shot("capabilities");
  return { sections: groups, "security-checks section": present > 0 };
}

async function checksWalk(page, shot) {
  await switchOn(page, "Item types");
  const offered = await switchOn(page, "Breach and two-step checks");
  await saveLogin(page, "GitHub", "password", "https://github.com");
  await saveLogin(page, "Shop", SHOP_PASSWORD, "https://shop.example");
  await visit(page, "settings/vaults");
  const key = page.getByRole("button", {
    name: "Check logins against breaches and two-step sites",
  });
  if (await key.count()) {
    await key.first().scrollIntoViewIfNeeded();
    await key.first().click();
    await page.waitForTimeout(2500);
    await page.locator("#security-checks").scrollIntoViewIfNeeded();
  }
  await shot("checks");
  return {
    "switch offered": offered,
    panel: (await page.locator("#security-checks").count()) > 0,
    marks: await marksIn(page, "#security-checks"),
  };
}

async function waitingWalk(page, shot, { code, answer }) {
  await sealWithPassword(page);
  await switchOn(page, "Networking");
  await visit(page, "settings/vaults");
  await page
    .getByRole("button", { name: "Pair with a drive", exact: true })
    .click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Pairing code", { exact: true }).fill(code);
  await sheet
    .getByRole("button", { name: "Pair with this drive", exact: true })
    .click();
  await sheet.waitFor({ state: "detached", timeout: 30_000 });
  // The person has not answered Chrome's question on this device yet.
  await answer("prompt");
  await visit(page, "vault");
  await page
    .getByRole("link", { name: "New item", exact: true })
    .first()
    .click();
  await page.getByLabel("Name", { exact: true }).first().fill("Made later");
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page.waitForTimeout(1500);
  await visit(page, "settings/vaults");
  // Long enough for a held request to time out where nothing gates it.
  await page.waitForTimeout(20_000);
  await page.locator("#tailnet-sync").scrollIntoViewIfNeeded();
  await shot("waiting");
  return { marks: await marksIn(page, "#tailnet-sync") };
}

async function openSlot(drive, operator, url) {
  const response = await fetch(`${drive}/v1/vault-drive/slots`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opensesame-operator": operator,
    },
    body: JSON.stringify({ label: "Desk", url }),
  });
  return (await response.json()).pairing_code;
}

async function capture(rawDir) {
  fs.mkdirSync(rawDir, { recursive: true });
  const port = 18795;
  const drive = `http://127.0.0.1:${port}`;
  const operator = `evidence-${crypto.randomUUID()}${crypto.randomUUID()}`;
  const slots = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-drive-"));
  const daemon = spawn(
    path.join(repo, "target/debug/opensesame"),
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
      stdio: "ignore",
    },
  );
  const serve = await tailscaleServeDrive(drive);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    args: serve.browserArgs,
  });
  const cdp = await browser.newBrowserCDPSession();
  const harness = createHarness({
    dist: fileURLToPath(new URL("../dist", import.meta.url)),
    origin,
    base,
    out: path.join(rawDir, ".log"),
  });
  const measured = {};
  try {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    for (const [width, device] of Object.entries(WIDTHS)) {
      const open = async () => {
        const { page, context } = await harness.newPage(browser, {
          device: { ...device, ignoreHTTPSErrors: true },
          remote: fixtures(rawDir),
        });
        await context.route(`${serve.url}/**`, (route) => route.continue());
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        const answer = (setting) =>
          cdp.send("Browser.setPermission", {
            permission: { name: "local-network-access" },
            setting,
            origin,
            browserContextId: targetInfo.browserContextId,
          });
        await answer("granted");
        await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(2500);
        const shot = (walk) =>
          page.screenshot({
            path: path.join(rawDir, `${side}-${walk}-${width}.png`),
          });
        return { page, context, shot, answer };
      };
      const guest = await open();
      await doorGuest(guest.page).click();
      await guest.page.waitForTimeout(1500);
      measured[`capabilities-${width}`] = await capabilitiesWalk(
        guest.page,
        guest.shot,
      );
      measured[`checks-${width}`] = await checksWalk(guest.page, guest.shot);
      await guest.context.close();

      const sealed = await open();
      const code = await openSlot(drive, operator, serve.url);
      measured[`waiting-${width}`] = await waitingWalk(
        sealed.page,
        sealed.shot,
        {
          code,
          answer: sealed.answer,
        },
      );
      await sealed.context.close();
    }
  } finally {
    await browser.close();
    serve.close();
    daemon.kill();
    fs.rmSync(slots, { recursive: true, force: true });
  }
  fs.writeFileSync(
    path.join(rawDir, `${side}-measurements.json`),
    JSON.stringify(measured, null, 2),
  );
  console.log(JSON.stringify(measured, null, 2));
}

function describe(value) {
  return Object.entries(value)
    .map(
      ([key, v]) => `${key}: ${Array.isArray(v) ? v.join(" · ") || "none" : v}`,
    )
    .join("<br>");
}

async function compose(rawDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const before = JSON.parse(
    fs.readFileSync(path.join(rawDir, "before-measurements.json")),
  );
  const after = JSON.parse(
    fs.readFileSync(path.join(rawDir, "after-measurements.json")),
  );
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
  });
  for (const key of Object.keys(after)) {
    const image = (s) =>
      `data:image/png;base64,${fs.readFileSync(path.join(rawDir, `${s}-${key}.png`)).toString("base64")}`;
    const column = (s, data) =>
      `<figure><figcaption><b>${s}</b><br>${describe(data ?? {})}</figcaption><img src="${image(s)}"></figure>`;
    await page.setContent(`<style>body{margin:16px;font:14px system-ui;background:#fff}
      main{display:grid;grid-template-columns:1fr 1fr;gap:16px}
      figure{margin:0}img{width:100%;border:1px solid #ccc}
      figcaption{min-height:5em;margin-bottom:8px}</style>
      <h3>${key}</h3><main>${column("before", before[key])}${column("after", after[key])}</main>`);
    await page.screenshot({
      path: path.join(outDir, `${key}.png`),
      fullPage: true,
    });
  }
  await browser.close();
}

if (mode === "capture") await capture(rawArg);
else if (mode === "compose") await compose(side, rawArg);
else
  throw new Error(
    "usage: capture before|after <raw-dir> | compose <raw-dir> <out-dir>",
  );
void outArg;
