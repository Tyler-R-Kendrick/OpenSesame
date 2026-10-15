import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
/** Prepared only; run after root supplies frozen builds and fixture GO. */
import { createJourney } from "./capture-support.mjs";
const repo = process.cwd();
const helper = (name) =>
  pathToFileURL(path.join(repo, "apps/pages/scripts/lib", name)).href;
const { createHarness } = await import(helper("static-origin-harness.mjs"));
const { createTailnetConnectFixture } = await import(
  helper("tailnet-connect-fixture.mjs")
);
const { startSecretBackendAppServer } = await import(
  helper("secret-backend-browser-server.mjs")
);
const { newBackendPage, enableBackendConnections, visitBackendRoute } =
  await import(helper("secret-backend-browser.mjs"));
const { sealWithPin, addCapabilities, lockVault, unlockWithPin } = await import(
  helper("pages-journey.mjs")
);
const { capabilityOnSwitch } = await import(helper("always-on.mjs"));
const { emittedTailnetWorker } = await import(
  helper("tailscale-installed-pwa-browser.mjs")
);
const { expect } = createRequire(path.join(repo, "apps/pages/package.json"))(
  "@playwright/test",
);
const out =
  process.env.PWA_TAILSCALE_EVIDENCE_OUT ??
  path.dirname(fileURLToPath(import.meta.url));
const phase = process.env.PAGES_CAPTURE_PHASE;
const dist = process.env.PAGES_VERIFY_DIST;
const cache = process.env.TAILNET_FIXTURE_CACHE;
if (!["before", "after"].includes(phase) || !dist || !cache)
  throw Error(
    "Frozen phase/dist and existing TAILNET_FIXTURE_CACHE are required",
  );
const sources = JSON.parse(
  fs.readFileSync(new URL("./source-manifest.json", import.meta.url), "utf8"),
);
const build = sources[phase];
if (
  process.env.PWA_COMPILED_PARENT !== build.parent ||
  process.env.PWA_COMPILED_TREE !== build.tree
)
  throw Error("Declared build parent/tree does not match evidence manifest");
const indexSha = createHash("sha256")
  .update(fs.readFileSync(path.join(dist, "index.html")))
  .digest("hex");
if (indexSha !== build.indexSha256)
  throw Error("Frozen build index does not match evidence manifest");
fs.mkdirSync(path.join(out, "raw", phase), { recursive: true });
const origin = "http://localhost:41911";
const base = "/OpenSesame/";
const h = createHarness({ dist, origin, base, out });
const measurements = [];
const homeMeasurements = [];
const workers = [];
const sockets = [];
const network = [];
const pins = JSON.parse(
  fs.readFileSync(
    path.join(repo, "apps/pages/src/lib/capabilities/tailscale-artifacts.json"),
    "utf8",
  ),
);
const workerAsset = emittedTailnetWorker(dist);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const compressed = fs.readFileSync(path.join(dist, pins.assets.wasm));
if (
  digest(compressed) !== pins.sdk.gzipHash ||
  digest(gunzipSync(compressed)) !== pins.sdk.wasmHash
)
  throw Error("Official SDK WASM pin mismatch");
if (
  digest(fs.readFileSync(path.join(dist, pins.assets.runtime))) !==
  pins.sdk.runtimeHash
)
  throw Error("Official Go runtime pin mismatch");
const assetReceipt = {
  sdk: pins.sdk,
  wasm: {
    file: pins.assets.wasm,
    bytes: compressed.length,
    sha256: digest(compressed),
  },
  runtime: { file: pins.assets.runtime, sha256: pins.sdk.runtimeHash },
  worker: {
    file: workerAsset,
    sha256: digest(fs.readFileSync(path.join(dist, workerAsset))),
  },
};
let fixture;
let app;
let browser;
let browserVersion = null;
function safe(value) {
  return fixture?.authKey
    ? String(value).replaceAll(fixture.authKey, "[fixture enrollment key]")
    : String(value);
}
function record(kind, detail) {
  h.record(
    kind === "network-failure" &&
      detail === "net::ERR_ABORTED: https://derp.fixture.test/derp/probe"
      ? "EXPECTED-derp-probe-cancellation"
      : kind,
    safe(detail),
  );
}

try {
  fixture = await createTailnetConnectFixture({ cache });
  app = await startSecretBackendAppServer(dist, origin, base);
  browser = await h.launch({ args: ["--no-sandbox", ...fixture.chromiumArgs] });
  browserVersion = browser.version();
  const {
    openNode,
    capture,
    showHeader,
    closedCount,
    expectOff,
    connect,
    probe,
    observeHome,
  } = createJourney({
    expect,
    visitBackendRoute,
    h,
    out,
    phase,
    base,
    fixture,
    workers,
    measurements,
    homeMeasurements,
    safe,
  });
  for (const width of [1280, 390]) {
    h.setStep(`${phase}-${width}-real-pin-vault`);
    const { page, context } = await newBackendPage(browser, {
      width,
      origin,
      providers: [
        fixture.controlUrl,
        "https://derp.fixture.test",
        "https://derp.fixture.test:41917",
      ],
      record,
    });
    page.on("worker", (worker) => {
      if (new URL(worker.url()).pathname !== base + workerAsset) return;
      const row = {
        width,
        url: worker.url(),
        startedDuring: h.step(),
        closed: false,
      };
      workers.push(row);
      worker.on("close", () => {
        row.closed = true;
        row.closedDuring = h.step();
      });
    });
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin === origin && /go-runtime|\.wasm\.gz$/.test(url.pathname))
        record("official-sdk-resource", url.pathname);
      network.push({
        step: h.step(),
        method: request.method(),
        origin: url.origin,
        path: url.pathname,
      });
    });
    page.on("websocket", (socket) => {
      const url = new URL(socket.url());
      const row = {
        width,
        origin: url.origin,
        path: url.pathname,
        sentFrames: 0,
        receivedFrames: 0,
        sentBytes: 0,
        receivedBytes: 0,
        closed: false,
      };
      sockets.push(row);
      socket.on("framesent", ({ payload }) => {
        row.sentFrames++;
        row.sentBytes += Buffer.byteLength(payload);
      });
      socket.on("framereceived", ({ payload }) => {
        row.receivedFrames++;
        row.receivedBytes += Buffer.byteLength(payload);
      });
      socket.on("close", () => {
        row.closed = true;
      });
    });
    try {
      await page.goto(origin + base, { waitUntil: "networkidle" });
      await sealWithPin(page);
      await enableBackendConnections(page, base);
      await addCapabilities(page, ["Tailnet networking"]);
      let panel = await openNode(page);
      h.setStep(`${phase}-${width}-initial`);
      await capture(page, width, "initial", { picture: false });
      await panel
        .getByLabel("Browser node hostname", { exact: true })
        .fill(`openss-status-${width}`);
      await panel
        .getByLabel("Tailscale control server", { exact: true })
        .fill(fixture.controlUrl);
      await panel
        .getByText("Join with an existing auth key", { exact: true })
        .click();
      const key = panel.getByLabel("Optional node auth key", { exact: true });
      await key.fill(fixture.authKey);
      h.check(
        (await key.getAttribute("type")) === "password",
        `${width}: enrollment key is concealed`,
      );
      h.setStep(`${phase}-${width}-connected-before-probe`);
      await connect(panel, width);
      if (phase === "after")
        await page
          .locator(".conn-settings__head")
          .getByRole("img", { name: "Browser node connected", exact: true })
          .waitFor();
      await showHeader(page, width);
      await capture(page, width, "connected-before-probe");
      h.setStep(`${phase}-${width}-real-peer`);
      await probe(panel, width);
      await showHeader(page, width);
      await capture(page, width, "real-peer");
      h.setStep(`${phase}-${width}-home-connected`);
      panel = await observeHome(page, width, "connected", true);
      h.setStep(`${phase}-${width}-stopped`);
      let closed = closedCount(width);
      await panel
        .getByRole("button", { name: "Disconnect browser node", exact: true })
        .click();
      await expect.poll(() => closedCount(width)).toBeGreaterThan(closed);
      await expectOff(page, panel, width, "stopped");
      await showHeader(page, width);
      await capture(page, width, "stopped");
      h.setStep(`${phase}-${width}-home-stopped`);
      panel = await observeHome(page, width, "stopped", false);
      h.setStep(`${phase}-${width}-locked`);
      await connect(panel, width);
      closed = closedCount(width);
      await lockVault(page);
      await expect.poll(() => closedCount(width)).toBeGreaterThan(closed);
      h.check(
        (await page.getByRole("img", { name: /^Connected: / }).count()) === 0,
        `${width}: lock removes live node authorization`,
      );
      await unlockWithPin(page);
      panel = await openNode(page);
      await expectOff(page, panel, width, "unlocked-after-lock");
      await showHeader(page, width);
      await capture(page, width, "unlocked-after-lock");
      h.setStep(`${phase}-${width}-networking-withdrawn`);
      await connect(panel, width);
      closed = closedCount(width);
      await visitBackendRoute(page, base, "settings/features");
      const networking = capabilityOnSwitch(page, "Tailnet networking");
      await networking.waitFor();
      await networking.click();
      await expect.poll(() => closedCount(width)).toBeGreaterThan(closed);
      await expect(
        page.getByRole("switch", { name: "Connections", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      panel = await openNode(page);
      await expectOff(page, panel, width, "networking-withdrawn");
      await expect(
        panel.getByRole("button", {
          name: "Connect browser node",
          exact: true,
        }),
      ).toBeDisabled();
      await showHeader(page, width);
      await capture(page, width, "networking-withdrawn");
      h.setStep(`${phase}-${width}-home-networking-withdrawn`);
      panel = await observeHome(page, width, "networking-withdrawn", false);
    } catch (error) {
      h.failures.push(`${h.step()}: ${safe(error.message)}`);
    } finally {
      await context.close();
    }
  }
} catch (error) {
  h.failures.push(`${h.step()}: ${safe(error.message)}`);
} finally {
  await browser?.close();
  await app?.close();
  await fixture?.close();
}
for (const row of h.log)
  if (
    [
      "PAGE-ERROR",
      "console-error",
      "HTTP-ERROR",
      "MISSING-ASSET",
      "unexpected-external-request",
      "worker-network-error",
      "network-failure",
    ].includes(row.kind)
  )
    h.failures.push(`${row.kind}: ${row.detail}`);
const protocol = fixture
  ? {
      controlUpgrades: fixture.control.filter(
        (r) =>
          r.kind === "upgrade" &&
          r.path === "/ts2021" &&
          r.subprotocol === "tailscale-control-protocol",
      ).length,
      derpUpgrades: fixture.derp.filter(
        (r) =>
          r.kind === "upgrade" &&
          r.path === "/derp" &&
          r.subprotocol === "derp",
      ).length,
      nativePeerGets: fixture.peer.filter(
        (r) => r.method === "GET" && r.path === "/proof",
      ).length,
    }
  : null;
h.check(
  (protocol?.controlUpgrades ?? 0) > 0,
  "Actual fixture observed Noise control WebSocket upgrades",
);
h.check(
  (protocol?.derpUpgrades ?? 0) > 0,
  "Actual fixture observed real DERP WebSocket upgrades",
);
h.check(
  (protocol?.nativePeerGets ?? 0) > 0,
  "Actual native peer received encrypted-tailnet GETs",
);
h.check(
  h.log.some(
    (r) => r.kind === "official-sdk-resource" && r.detail.endsWith(".wasm.gz"),
  ),
  "Actual official owned WASM asset loaded",
);
const receipt = {
  phase,
  dist,
  browserVersion,
  sourceParent: process.env.PWA_COMPILED_PARENT ?? null,
  sourceTree: process.env.PWA_COMPILED_TREE ?? null,
  sourceDescription: process.env.PWA_COMPILED_DESCRIPTION ?? null,
  indexSha256: digest(fs.readFileSync(path.join(dist, "index.html"))),
  assetReceipt,
  measurements,
  homeMeasurements,
  workers,
  sockets,
  network,
  protocol,
  fixture: fixture
    ? { control: fixture.control, derp: fixture.derp, peer: fixture.peer }
    : null,
  log: h.log,
  failures: h.failures,
  limits: [
    "Real pinned Headscale/DERP/native peer infrastructure, not a hosted Tailscale tenant/account.",
    "Transparent test-provider HTTP/WebSocket edges supply fixture CORS/TLS and preserve real encrypted protocol traffic.",
    "Generated DERP certificate uses the existing fixture SPKI-only Chromium exception; no global TLS ignore or home/system trust changes.",
    "Networking toggle verifies capability-consent/lease withdrawal; hot egress-only withdrawal is a separate integration-test obligation.",
    "Status journey does not rerun historical installed-PWA stopped-app-socket/cache proof.",
    "Official browser SDK exposes GET; no general VPN, host interception, mutations or app/OAuth management is claimed.",
  ],
};
fs.writeFileSync(
  path.join(out, `${phase}-metrics.json`),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    phase,
    checks: h.log.filter((r) => r.kind === "PASS").length,
    failures: h.failures,
    protocol,
  }),
);
if (h.failures.length) process.exitCode = 1;
