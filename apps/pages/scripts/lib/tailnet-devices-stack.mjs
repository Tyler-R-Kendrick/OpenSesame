// The stack the tailnet device walks run on (ADR 0168): a real `opensesame`
// daemon connected to a stand-in for api.tailscale.com, the CLI a person runs
// beside it, and a dedicated-origin build of the page served under its
// production address. Shared by `verify-tailnet-devices.mjs` and
// `capture-tailnet-devices-evidence.mjs`, so the evidence walks exactly what
// the gate walks.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { dedicatedSite } from "./live-dedicated.mjs";
import { createHarness } from "./static-origin-harness.mjs";
import { API_TOKEN, TAILNET, startTailscaleStub } from "./tailscale-stub.mjs";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const binary = path.join(repo, "target/debug/opensesame");

export async function until(check, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Start the stub, connect the daemon to it with the CLI, run the daemon and a
 * browser. `dist` defaults to the dedicated build; `out` is where shots go.
 */
export async function startStack({ out, dist = dedicatedSite().dist, port }) {
  const { origin } = dedicatedSite();
  const base = process.env.VITE_BASE ?? "/OpenSesame/";
  const daemonUrl = `http://127.0.0.1:${port}`;
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
  const cli = (...args) =>
    execFileSync(binary, ["daemon", "tailnet", ...args], {
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  const secretFile = path.join(os.tmpdir(), `tailnet-token-${process.pid}`);
  fs.writeFileSync(secretFile, `${API_TOKEN}\n`, { mode: 0o600 });
  try {
    cli(
      "connect",
      "--tailnet",
      TAILNET,
      "--api-token",
      "--secret-file",
      secretFile,
    );
  } finally {
    fs.rmSync(secretFile);
  }
  const daemon = spawn(
    binary,
    ["daemon", "run", "--listen", `127.0.0.1:${port}`],
    { env, stdio: ["ignore", "ignore", "inherit"] },
  );
  // A person answers Chrome's local-network prompt once; headless cannot.
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    headless: true,
    args: [
      "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
    ],
  });
  await until(async () => (await fetch(`${daemonUrl}/health`)).ok, "daemon");

  const pages = [];
  const stack = {
    origin,
    base,
    state,
    stub,
    cli,
    browser,
    pages,
    /** `opensesame daemon tailnet pair` for this page; the link it prints. */
    pairLink(role, label) {
      const printed = cli(
        ...["pair", "--origin", origin, "--role", role, "--url", daemonUrl],
        ...["--label", label, "--pages-url", `${origin}${base}`, "--no-qr"],
      );
      const link = printed.match(/^link\s+(\S+)$/m)?.[1];
      if (!link) throw new Error(`pair printed no link:\n${printed}`);
      return link;
    },
    async browserPage(options) {
      const { page, context } = await harness.newPage(browser, options);
      await context.route(`${daemonUrl}/**`, (route) => route.continue());
      pages.push(page);
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(3000);
      return { page, errors };
    },
    async shot(page, name) {
      const file = path.join(out, `${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`  ${file}`);
    },
    async close() {
      await browser.close();
      daemon.kill();
      await stub.close();
      fs.rmSync(state, { recursive: true, force: true });
    },
  };
  return stack;
}

export async function visit(page, base, route) {
  await page.evaluate((href) => {
    history.pushState(null, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
  await page.waitForTimeout(1200);
}

/** Identity (the section the panel is in), then Networking (the panel). */
export async function deviceManagementOn(page, base) {
  await visit(page, base, "settings/capabilities");
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
export async function pairByLink(page, base, link) {
  const fragment = new URL(link).hash;
  await visit(page, base, `identity?view=devices${fragment}`);
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
