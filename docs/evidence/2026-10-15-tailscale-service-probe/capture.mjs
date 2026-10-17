/** Real emitted official Tailscale SDK: native service404 and successful retry. */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertMembership, serviceProbe } from "./probe-support.mjs";
const repo = process.cwd();
const helper = (name) =>
  pathToFileURL(path.join(repo, "apps/pages/scripts/lib", name)).href;
const evidence = (name) =>
  pathToFileURL(path.join(repo, "docs/evidence", name)).href;
const {
  attachObservers,
  checkNetwork,
  digest,
  officialAssets,
  protocolReceipt,
} = await import(
  evidence("2026-10-15-tailscale-primary-ui/capture-observers.mjs")
);
const { createJourney } = await import(
  evidence("2026-10-15-tailscale-status/capture-support.mjs")
);
const { createHarness } = await import(helper("static-origin-harness.mjs"));
const { createTailnetConnectFixture } = await import(
  helper("tailnet-connect-fixture.mjs")
);
const { startSecretBackendAppServer } = await import(
  helper("secret-backend-browser-server.mjs")
);
const { newBackendPage, enableBackendConnections, visitBackendRoute } =
  await import(helper("secret-backend-browser.mjs"));
const { sealWithPin, addCapabilities } = await import(
  helper("pages-journey.mjs")
);
const { emittedTailnetWorker } = await import(
  helper("tailscale-installed-pwa-browser.mjs")
);
const { expect } = createRequire(path.join(repo, "apps/pages/package.json"))(
  "@playwright/test",
);
const out =
  process.env.PWA_TAILSCALE_PROBE_EVIDENCE_OUT ??
  path.dirname(fileURLToPath(import.meta.url));
const phase = process.env.PAGES_CAPTURE_PHASE;
const dist = process.env.PAGES_VERIFY_DIST;
const cache = process.env.TAILNET_FIXTURE_CACHE;
if (!["before", "after"].includes(phase) || !dist || !cache)
  throw Error("Frozen phase/dist and fixture cache required");
const sources = JSON.parse(
  fs.readFileSync(new URL("./source-manifest.json", import.meta.url)),
);
const build = sources.builds[phase];
if (
  digest(fs.readFileSync(path.join(dist, "index.html"))) !== build.indexSha256
)
  throw Error("Frozen build receipt mismatch");
fs.mkdirSync(path.join(out, "raw", phase), { recursive: true });
const origin = "http://localhost:41911";
const base = "/OpenSesame/";
const h = createHarness({ dist, origin, base, out });
const workerAsset = emittedTailnetWorker(dist);
const assetReceipt = officialAssets(repo, dist, workerAsset);
const c = {
  h,
  expect,
  phase,
  out,
  base,
  workers: [],
  measurements: [],
  homeMeasurements: [],
  probes: [],
  notices: [],
};
const network = [];
const sockets = [];
let app;
let browser;
let browserVersion;
function safe(value) {
  return c.fixture?.authKey
    ? String(value).replaceAll(c.fixture.authKey, "[fixture enrollment key]")
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
async function configure(page, panel, width) {
  await panel
    .getByLabel("Browser node hostname", { exact: true })
    .fill(`openss-status-${width}`);
  await panel
    .getByLabel("Tailscale control server", { exact: true })
    .fill(c.fixture.controlUrl);
  await panel
    .getByText("Join with an existing auth key", { exact: true })
    .click();
  const key = panel.getByLabel("Optional node auth key", { exact: true });
  await key.fill(c.fixture.authKey);
  h.check(
    (await key.getAttribute("type")) === "password",
    `${width}: transient enrollment key concealed`,
  );
  await c.journey.connect(panel, width);
  await assertMembership(c, page, panel, width, "connected-before-service");
  await panel
    .getByText("Join with an existing auth key", { exact: true })
    .click();
  await c.journey.capture(page, width, "connected-before-service", {
    picture: false,
  });
}
async function stop(page, panel, width) {
  h.setStep(`${phase}-${width}-stopped`);
  const before = c.journey.closedCount(width);
  await panel
    .getByRole("button", { name: "Disconnect browser node", exact: true })
    .click();
  await expect.poll(() => c.journey.closedCount(width)).toBeGreaterThan(before);
  await c.journey.expectOff(page, panel, width, "stopped");
  await c.journey.capture(page, width, "stopped", { picture: false });
}
async function runViewport(width) {
  const { page, context } = await newBackendPage(browser, {
    width,
    origin,
    providers: [
      c.fixture.controlUrl,
      "https://derp.fixture.test",
      "https://derp.fixture.test:41917",
    ],
    record,
  });
  attachObservers({
    page,
    context,
    width,
    h,
    origin,
    base,
    workerAsset,
    workers: c.workers,
    network,
    sockets,
    record,
  });
  try {
    h.setStep(`${phase}-${width}-pin-vault`);
    await page.goto(origin + base, { waitUntil: "networkidle" });
    await sealWithPin(page);
    await enableBackendConnections(page, base);
    await addCapabilities(page, ["Tailnet networking"]);
    const panel = await c.journey.openNode(page);
    await configure(page, panel, width);
    await serviceProbe(c, page, panel, width, "/missing", "missing-service");
    await serviceProbe(c, page, panel, width, "/proof", "successful-retry");
    await stop(page, panel, width);
  } catch (error) {
    h.failures.push(`${h.step()}: ${safe(error.message)}`);
  } finally {
    await context.close();
  }
}
try {
  c.fixture = await createTailnetConnectFixture({ cache });
  app = await startSecretBackendAppServer(dist, origin, base);
  browser = await h.launch({
    args: ["--no-sandbox", ...c.fixture.chromiumArgs],
  });
  browserVersion = browser.version();
  c.journey = createJourney({
    ...c,
    fixture: c.fixture,
    visitBackendRoute,
    safe,
  });
  for (const width of [1280, 390]) await runViewport(width);
} catch (error) {
  h.failures.push(`${h.step()}: ${safe(error.message)}`);
} finally {
  await browser?.close();
  await app?.close();
  await c.fixture?.close();
}
const protocol = c.fixture
  ? {
      ...protocolReceipt(c.fixture),
      nativePeerMissingGets: c.fixture.peer.filter(
        (r) => r.method === "GET" && r.path === "/missing",
      ).length,
      nativePeerTotalGets: c.fixture.peer.filter((r) => r.method === "GET")
        .length,
    }
  : null;
const managementRequests = checkNetwork(h, network, protocol);
h.check(
  c.workers.length === 2 && c.workers.every((w) => w.closed),
  "Both actual emitted SDK workers closed after disconnect and context cleanup",
);
const receipt = {
  phase,
  dist,
  build,
  browserVersion,
  assetReceipt,
  measurements: c.measurements,
  probes: c.probes,
  notices: c.notices,
  workers: c.workers,
  network,
  sockets,
  protocol,
  managementRequests,
  fixture: c.fixture
    ? { control: c.fixture.control, derp: c.fixture.derp, peer: c.fixture.peer }
    : null,
  log: h.log,
  failures: h.failures,
  limits: [
    "Real pinned Headscale/DERP/native test peer, not a hosted tenant or account.",
    "Native CLI exists only in test infrastructure; PWA uses unchanged official SDK WASM.",
    "Transparent fixture CORS/TLS protocol edges and exact fixture certificate SPKI exception; no global TLS ignore or ordinary hosted PKI claim.",
    "Actual404 and200 inside encrypted tailnet service stream; no response interception, DOM staging, app backend or extension.",
    "No response body rendering, private SDK state reveal or enrollment key serialization.",
    "No late-request race, hosted OAuth, arbitrary VPN, installed offline-cache or hosted CORS claim.",
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
    states: c.measurements.length,
  }),
);
if (h.failures.length) process.exitCode = 1;
