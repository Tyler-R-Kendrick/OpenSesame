/** Conditional management HTTP fixture; hosted account consent is explicitly synthetic. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { startIdentityAppServer } from "./lib/identity-browser-server.mjs";
import { sealWithPin, unlockWithPin } from "./lib/pages-journey.mjs";
import {
  enableBackendConnections,
  newBackendPage,
  visitBackendRoute,
} from "./lib/secret-backend-browser.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { exerciseTailscaleProvisioning } from "./lib/tailscale-provisioning-browser.mjs";
import { startTailscaleProvisioningServer } from "./lib/tailscale-provisioning-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(
  process.env.PAGES_VERIFY_DIST ??
    path.join(here, "../dist-tailscale-browser-verify"),
);
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "../../../work/tailscale-provisioning-browser"),
);
const origin = "http://localhost:41911";
const managementOrigin = "http://127.0.0.1:41913";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
if (!fs.existsSync(path.join(dist, "index.html")))
  throw new Error(
    `Build the declared Tailscale verification profile first: ${dist}`,
  );
fs.mkdirSync(out, { recursive: true });
const h = createHarness({ dist, origin, base, out });
let app;
let browser;
const observations = [];

async function coldCredential(page, fixture, width) {
  const id = await page
    .getByLabel("Registered client ID", { exact: true })
    .inputValue();
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPin(page);
  await visitBackendRoute(page, base, "settings/connections/tailscale");
  await expect(
    page.getByLabel("Registered client ID", { exact: true }),
  ).toHaveValue(id);
  await visitBackendRoute(page, base, "vault?f=all");
  const row = page
    .getByRole("treeitem")
    .filter({ hasText: "Tailscale OAuth app secret · " });
  await expect(row).toHaveCount(1);
  await row.click();
  await page.getByRole("button", { name: /^Reveal [Tt]oken$/ }).click();
  await expect(
    page.getByText(fixture.app.clientSecret, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Hide [Tt]oken$/ }).click();
  h.check(
    true,
    `${width}: management app client secret is a real vault Token item after cold PIN unlock`,
  );
}
async function viewport(width) {
  h.setStep(`${width}-conditional-management-http`);
  console.log(h.step());
  const server = await startTailscaleProvisioningServer({
    allowedOrigin: origin,
  });
  browser = await h.launch({ args: ["--no-sandbox", ...server.chromiumArgs] });
  const { context, page } = await newBackendPage(browser, {
    width,
    origin,
    providers: [managementOrigin, "https://login.tailscale.com"],
    record: h.record,
  });
  try {
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await sealWithPin(page);
    await enableBackendConnections(page, base);
    await visitBackendRoute(page, base, "settings/connections/tailscale");
    await exerciseTailscaleProvisioning({
      page,
      fixture: server.fixture,
      apiBase: `${managementOrigin}/tailscale-fixture`,
      check: (name, condition) => h.check(condition, `${width}: ${name}`),
    });
    await coldCredential(page, server.fixture, width);
    h.check(
      server.requests.some((entry) => entry.method === "OPTIONS") &&
        server.requests.every((entry) => entry.originAllowed),
      `${width}: real conditional management API accepted native CORS preflights and the exact app origin`,
    );
    h.check(
      server.consentRequests.length === 3 &&
        server.consentRequests.every(
          (entry) => entry.path === "/a/oauth_authorize",
        ),
      `${width}: explicitly synthetic consent used actual pinned HTTPS sockets without browser request interception`,
    );
  } finally {
    observations.push({
      width,
      requests: server.requests,
      consentRequests: server.consentRequests,
      stats: server.fixture.stats,
    });
    await context.close();
    await browser.close();
    await server.close();
  }
}
try {
  app = await startIdentityAppServer(dist, origin, base);
  for (const width of [1280, 390]) await viewport(width);
} catch (error) {
  h.failures.push(`${h.step()}: ${error.message}`);
} finally {
  await browser?.close();
  await app?.close();
}
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
      observations,
      limits: [
        "Hosted Tailscale account consent was replaced by an explicitly synthetic test page.",
        "Management HTTP endpoints are real socket protocol fixtures; this does not establish CORS permission on Tailscale's hosted management API.",
        "Actual browser-node enrollment/control/DERP is tested separately against real Headscale and a native peer.",
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
    `PASS conditional management HTTP and vault custody; hosted consent synthetic: ${out}`,
  );
