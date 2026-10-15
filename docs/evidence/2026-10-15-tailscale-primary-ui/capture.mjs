/** Actual primary Tailscale UI and cold persisted-config journey; no product mutations. */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertHomeMembership,
  assertPrimary,
  attachObservers,
  checkNetwork,
  digest,
  officialAssets,
  primaryInventory,
  protocolReceipt,
} from "./capture-observers.mjs";
const repo = process.cwd();
const helper = (name) =>
  pathToFileURL(path.join(repo, "apps/pages/scripts/lib", name)).href;
const { createJourney } = await import(
  pathToFileURL(
    path.join(
      repo,
      "docs/evidence/2026-10-15-tailscale-status/capture-support.mjs",
    ),
  ).href
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
  process.env.PWA_TAILSCALE_PRIMARY_EVIDENCE_OUT ??
  path.dirname(fileURLToPath(import.meta.url));
const phase = process.env.PAGES_CAPTURE_PHASE;
const dist = process.env.PAGES_VERIFY_DIST;
const cache = process.env.TAILNET_FIXTURE_CACHE;
if (!["before", "after"].includes(phase) || !dist || !cache)
  throw Error("Frozen phase/dist and verified fixture cache required");
const sources = JSON.parse(
  fs.readFileSync(new URL("./source-manifest.json", import.meta.url)),
);
const build = sources.builds[phase];
if (
  digest(fs.readFileSync(path.join(dist, "index.html"))) !== build.indexSha256
)
  throw Error("Frozen build index does not match receipt");
fs.mkdirSync(path.join(out, "raw", phase), { recursive: true });
const origin = "http://localhost:41911";
const base = "/OpenSesame/";
const h = createHarness({ dist, origin, base, out });
const measurements = [];
const homeMeasurements = [];
const inventories = [];
const workers = [];
const network = [];
const sockets = [];
const workerAsset = emittedTailnetWorker(dist);
const assetReceipt = officialAssets(repo, dist, workerAsset);
let fixture;
let app;
let browser;
let browserVersion;
let journey;
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
async function inspect(page, width, stage) {
  const inventory = await primaryInventory(page);
  inventories.push({ width, stage, ...inventory });
  assertPrimary(h, phase, width, stage, inventory);
}
async function positive(page, panel, width, step) {
  h.setStep(`${phase}-${width}-${step}`);
  await journey.connect(panel, width);
  await page
    .locator(".conn-settings__head")
    .getByRole("img", { name: "Browser node connected", exact: true })
    .waitFor();
  await journey.capture(page, width, step, { picture: false });
  await journey.probe(panel, width);
}
async function home(page, width, stage, live) {
  h.setStep(`${phase}-${width}-home-${stage}`);
  const panel = await journey.observeHome(page, width, stage, live);
  assertHomeMembership(h, width, stage, live, homeMeasurements);
  return panel;
}
async function coldRestore(page, width, hostname) {
  h.setStep(`${phase}-${width}-cold-restored-primary`);
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPin(page);
  const panel = await journey.openNode(page);
  await expect(
    panel.getByLabel("Browser node hostname", { exact: true }),
  ).toHaveValue(hostname);
  await expect(
    panel.getByLabel("Tailscale control server", { exact: true }),
  ).toHaveValue(fixture.controlUrl);
  await expect(
    panel.getByLabel("Optional node auth key", { exact: true }),
  ).toHaveValue("");
  await expect(
    panel.getByRole("button", { name: "Connect browser node", exact: true }),
  ).toBeEnabled();
  await journey.expectOff(page, panel, width, "cold-restored-primary");
  h.check(
    true,
    `${width}: cold PIN boot restored saved node configuration and empty auth key without auto-connect`,
  );
  await inspect(page, width, "cold-restored-primary");
  await journey.showHeader(page, width);
  await journey.capture(page, width, "cold-restored-primary");
  return panel;
}
async function stop(page, panel, width) {
  h.setStep(`${phase}-${width}-stopped`);
  const before = journey.closedCount(width);
  await panel
    .getByRole("button", { name: "Disconnect browser node", exact: true })
    .click();
  await expect.poll(() => journey.closedCount(width)).toBeGreaterThan(before);
  await journey.expectOff(page, panel, width, "stopped");
  await journey.capture(page, width, "stopped", { picture: false });
  return home(page, width, "stopped", false);
}
async function lockAndWithdraw(page, width) {
  h.setStep(`${phase}-${width}-locked`);
  let before = journey.closedCount(width);
  await lockVault(page);
  await expect.poll(() => journey.closedCount(width)).toBeGreaterThan(before);
  h.check(
    (await page.getByRole("img", { name: /^Connected: / }).count()) === 0,
    `${width}: actual vault lock removes live node status`,
  );
  await unlockWithPin(page);
  let panel = await journey.openNode(page);
  await journey.expectOff(page, panel, width, "unlocked-after-lock");
  await journey.capture(page, width, "unlocked-after-lock", { picture: false });
  await journey.connect(panel, width);
  h.setStep(`${phase}-${width}-networking-withdrawn`);
  before = journey.closedCount(width);
  await visitBackendRoute(page, base, "settings/features");
  await capabilityOnSwitch(page, "Tailnet networking").click();
  await expect.poll(() => journey.closedCount(width)).toBeGreaterThan(before);
  await expect(
    page.getByRole("switch", { name: "Connections", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  panel = await journey.openNode(page);
  await journey.expectOff(page, panel, width, "networking-withdrawn");
  await expect(
    panel.getByRole("button", { name: "Connect browser node", exact: true }),
  ).toBeDisabled();
  await journey.capture(page, width, "networking-withdrawn", {
    picture: false,
  });
  await inspect(page, width, "networking-withdrawn");
  await home(page, width, "networking-withdrawn", false);
}
async function runViewport(width) {
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
  attachObservers({
    page,
    context,
    width,
    h,
    origin,
    base,
    workerAsset,
    workers,
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
    let panel = await journey.openNode(page);
    const hostname = `openss-status-${width}`;
    await panel
      .getByLabel("Browser node hostname", { exact: true })
      .fill(hostname);
    await panel
      .getByLabel("Tailscale control server", { exact: true })
      .fill(fixture.controlUrl);
    await expect(
      panel.getByRole("button", { name: "Connect browser node", exact: true }),
    ).toBeEnabled();
    h.setStep(`${phase}-${width}-configured-primary`);
    await inspect(page, width, "configured-primary");
    await journey.showHeader(page, width);
    await journey.capture(page, width, "configured-primary");
    await panel
      .getByText("Join with an existing auth key", { exact: true })
      .click();
    const key = panel.getByLabel("Optional node auth key", { exact: true });
    await key.fill(fixture.authKey);
    h.check(
      (await key.getAttribute("type")) === "password",
      `${width}: transient enrollment key concealed`,
    );
    await positive(page, panel, width, "connected-before-peer");
    panel = await home(page, width, "connected", true);
    panel = await stop(page, panel, width);
    panel = await coldRestore(page, width, hostname);
    await positive(page, panel, width, "cold-reconnected-before-peer");
    await lockAndWithdraw(page, width);
  } catch (error) {
    h.failures.push(`${h.step()}: ${safe(error.message)}`);
  } finally {
    await context.close();
  }
}
try {
  fixture = await createTailnetConnectFixture({ cache });
  app = await startSecretBackendAppServer(dist, origin, base);
  browser = await h.launch({ args: ["--no-sandbox", ...fixture.chromiumArgs] });
  browserVersion = browser.version();
  journey = createJourney({
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
  for (const width of [1280, 390]) await runViewport(width);
} catch (error) {
  h.failures.push(`${h.step()}: ${safe(error.message)}`);
} finally {
  await browser?.close();
  await app?.close();
  await fixture?.close();
}
const protocol = fixture ? protocolReceipt(fixture) : null;
const managementRequests = checkNetwork(h, network, protocol);
const receipt = {
  phase,
  dist,
  build,
  browserVersion,
  assetReceipt,
  measurements,
  homeMeasurements,
  inventories,
  workers,
  network,
  sockets,
  protocol,
  managementRequests,
  fixture: fixture
    ? { control: fixture.control, derp: fixture.derp, peer: fixture.peer }
    : null,
  log: h.log,
  failures: h.failures,
  limits: [
    "Real pinned Headscale/DERP/native test peer, not a hosted Tailscale tenant/account.",
    "Transparent provider-fixture CORS/TLS edges forward real encrypted protocols, not an OpenSesame application backend.",
    "Existing narrow fixture certificate SPKI exception; no global TLS ignore or ordinary hosted PKI claim.",
    "Cold document reload uses live static server, not an installed-PWA/offline-cache claim.",
    "Consent/lease withdrawal, not a surgical enabled-capability egress-only edit.",
    "Only successful HTTP200 GET is exercised; non2xx-result presentation is a separate source slice.",
    "No private SDK Token reveal, input credential serialization, general VPN or OAuth management proof.",
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
    providerStates: measurements.length,
    homeStates: homeMeasurements.length,
    primaryInventories: inventories.map((r) => ({
      width: r.width,
      stage: r.stage,
      panels: r.panels.map((p) => p.name),
    })),
  }),
);
if (h.failures.length) process.exitCode = 1;
