/** Actual emitted official SDK → real Headscale/Noise → DERP → native peer GET. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { startIdentityAppServer } from "./lib/identity-browser-server.mjs";
import {
  addCapabilities,
  lockVault,
  sealWithPin,
  unlockWithPin,
} from "./lib/pages-journey.mjs";
import {
  newBackendPage,
  visitBackendRoute,
} from "./lib/secret-backend-browser.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { createTailnetConnectFixture } from "./lib/tailnet-connect-fixture.mjs";
import { exerciseTailscaleBrowserNode } from "./lib/tailscale-browser-node-browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(
  process.env.PAGES_VERIFY_DIST ??
    path.join(here, "../dist-tailscale-browser-verify"),
);
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "../../../work/tailnet-browser-node"),
);
const origin = "http://localhost:41911";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
if (!fs.existsSync(path.join(dist, "index.html")))
  throw new Error(`Build the declared Tailnet profile first: ${dist}`);
fs.mkdirSync(out, { recursive: true });
const h = createHarness({ dist, origin, base, out });
let fixture;
let app;
let browser;

async function openNode(page) {
  await visitBackendRoute(page, base, "settings/connections/tailscale");
  await page
    .getByRole("region", { name: "Tailscale browser node", exact: true })
    .waitFor();
}
async function verifyPrivateState(page, hostname, width) {
  await visitBackendRoute(page, base, "vault?f=all");
  const title = `Tailscale browser node private state · ${hostname}`;
  const row = page.getByRole("treeitem").filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await row.click();
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  await page.getByRole("button", { name: /^Reveal [Tt]oken$/ }).click();
  const token = page.locator(".frow__value").filter({ hasText: /^\{/ });
  await expect(token).toHaveCount(1);
  // Only retain the boolean. SDK private keys never enter browser evidence/logs.
  const populated = await token.evaluate((node) => {
    try {
      return Object.keys(JSON.parse(node.textContent)).length > 0;
    } catch {
      return false;
    }
  });
  h.check(
    populated,
    `${width}: actual vault Token contains persisted SDK private state after cold PIN unlock`,
  );
  await page.getByRole("button", { name: /^Hide [Tt]oken$/ }).click();
  await openNode(page);
}
async function reconnect(page, hostname, width) {
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPin(page);
  await openNode(page);
  await expect(
    page.getByLabel("Browser node hostname", { exact: true }),
  ).toHaveValue(hostname);
  await expect(
    page.getByLabel("Tailscale control server", { exact: true }),
  ).toHaveValue(fixture.controlUrl);
  await verifyPrivateState(page, hostname, width);
  const panel = page.getByRole("region", {
    name: "Tailscale browser node",
    exact: true,
  });
  const before = fixture.peer.length;
  await panel
    .getByRole("button", { name: "Connect browser node", exact: true })
    .click();
  await panel
    .getByRole("img", { name: /^Connected: / })
    .waitFor({ timeout: 90_000 });
  await panel
    .getByLabel("Tailnet service URL", { exact: true })
    .fill(fixture.peerUrl);
  await panel
    .getByRole("button", { name: "Test tailnet service", exact: true })
    .click();
  await panel
    .getByRole("img", { name: /^HTTP 200 · / })
    .waitFor({ timeout: 45_000 });
  h.check(
    fixture.peer.length > before,
    `${width}: cold-unlocked private state reconnects without another auth key and reaches the actual native peer`,
  );
  await panel
    .getByRole("button", { name: "Disconnect browser node", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Forget local browser node", exact: true })
    .click();
  await panel
    .getByRole("button", {
      name: "Confirm forget local browser node",
      exact: true,
    })
    .click();
  await expect(
    panel.getByRole("button", {
      name: "Forget local browser node",
      exact: true,
    }),
  ).toHaveCount(0);
  await visitBackendRoute(page, base, "vault?f=all");
  await expect(
    page.getByRole("treeitem").filter({
      hasText: `Tailscale browser node private state · ${hostname}`,
    }),
  ).toHaveCount(0);
  h.check(
    true,
    `${width}: explicit forget removes the node's vault credential and saved connection`,
  );
}
async function runViewport(width) {
  h.setStep(`${width}-official-sdk-real-tailnet`);
  console.log(h.step());
  const hostname = `openss-browser-${width}`;
  const { page, context } = await newBackendPage(browser, {
    width,
    origin,
    providers: [
      fixture.controlUrl,
      "https://derp.fixture.test",
      "https://derp.fixture.test:41917",
    ],
    record: h.record,
  });
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && /go-runtime|\.wasm\.gz$/.test(url.pathname))
      h.record("official-sdk-resource", url.pathname);
  });
  try {
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await sealWithPin(page);
    await addCapabilities(page, ["Connections", "Tailnet networking"]);
    await openNode(page);
    const before = fixture.peer.length;
    await exerciseTailscaleBrowserNode({
      page,
      check: h.check,
      hostname,
      controlURL: fixture.controlUrl,
      authKey: fixture.authKey,
      peerURL: fixture.peerUrl,
      peerObserved: () => fixture.peer.length > before,
      lockAndUnlock: async () => {
        await lockVault(page);
        await unlockWithPin(page);
        await openNode(page);
      },
    });
    await reconnect(page, hostname, width);
    h.check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${width}: actual Tailnet journey fits the viewport`,
    );
  } catch (error) {
    // Do not capture a vault view that might currently reveal SDK private keys.
    h.failures.push(
      `${width}: ${error.message.replaceAll(fixture.authKey, "[fixture enrollment key]")}`,
    );
  } finally {
    await context.close();
  }
}
try {
  fixture = await createTailnetConnectFixture();
  app = await startIdentityAppServer(dist, origin, base);
  browser = await h.launch({ args: ["--no-sandbox", ...fixture.chromiumArgs] });
  for (const width of [1280, 390]) await runViewport(width);
} catch (error) {
  h.failures.push(`${h.step()}: ${error.message}`);
} finally {
  await browser?.close();
  await app?.close();
  await fixture?.close();
}
if (fixture) {
  h.check(
    fixture.control.some(
      (entry) =>
        entry.kind === "upgrade" &&
        entry.path === "/ts2021" &&
        entry.subprotocol === "tailscale-control-protocol",
    ),
    "Actual browser WebSocket carried the official Noise control protocol",
  );
  h.check(
    fixture.derp.some(
      (entry) =>
        entry.kind === "upgrade" &&
        entry.path === "/derp" &&
        entry.subprotocol === "derp",
    ),
    "Actual browser WebSocket carried encrypted peer traffic through real DERP",
  );
}
h.check(
  h.log.some(
    (entry) =>
      entry.kind === "official-sdk-resource" &&
      entry.detail.endsWith(".wasm.gz"),
  ),
  "The emitted official WASM asset loaded in the real browser",
);
for (const entry of h.log) {
  if (
    [
      "PAGE-ERROR",
      "console-error",
      "HTTP-ERROR",
      "MISSING-ASSET",
      "unexpected-external-request",
      "worker-network-error",
    ].includes(entry.kind)
  )
    h.failures.push(`${entry.kind}: ${entry.detail}`);
  if (
    entry.kind === "network-failure" &&
    !entry.detail.startsWith("net::ERR_ABORTED:")
  )
    h.failures.push(`${entry.kind}: ${entry.detail}`);
}
fs.writeFileSync(
  path.join(out, "results.json"),
  `${JSON.stringify(
    {
      failures: h.failures,
      log: h.log,
      fixture: fixture
        ? { control: fixture.control, derp: fixture.derp, peer: fixture.peer }
        : null,
      limits: [
        "Real pinned Headscale/DERP/native peer test infrastructure; no hosted Tailscale tenant is claimed.",
        "The official SDK exposes GET; mutating tailnet service operations are not claimed.",
      ],
    },
    null,
    2,
  )}\n`,
);
if (h.failures.length) {
  console.error(h.failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `PASS official browser SDK, vault custody, real control/DERP/native peer: ${out}`,
  );
