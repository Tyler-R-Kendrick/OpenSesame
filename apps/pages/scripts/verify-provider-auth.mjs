import { execFileSync } from "node:child_process";
/** Required browser gate: real provider-approved OIDC, actual static callback. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { runProviderAuthGoogleContract } from "../../../scripts/test/provider-auth-google-contract.mjs";
import { proveRealProviderGrant } from "../../../scripts/test/provider-auth-real-oidc.mjs";
import {
  configureOpenBao,
  startProviderIssuer,
} from "../../../scripts/test/provider-auth-services.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { providerAuthBrowserJourney } from "./provider-auth-browser.mjs";
import { buildProviderAuthDeployment } from "./provider-auth-build.mjs";
import {
  closeProviderAuthResources,
  providerAuthCases,
  providerAuthPhases,
  retainProviderAuthTls,
} from "./provider-auth-case-runtime.mjs";
import { startProviderAuthOrigin } from "./provider-auth-origin.mjs";
import { proveCallbackWorkerIsolation } from "./provider-auth-service-worker.mjs";
import { proveManualProviderTokens } from "./provider-auth-token-browser.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const out = path.resolve(
  process.env.PROVIDER_AUTH_OUT ??
    fs.mkdtempSync(path.join(os.tmpdir(), "opensesame-provider-auth-")),
);
const base = process.env.VITE_BASE ?? "/OpenSesame/";
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
fs.rmSync(path.join(out, "receipt.json"), { force: true });
const phases = providerAuthPhases(out);
const deployment = await phases.run("dedicated-build", () =>
  buildProviderAuthDeployment({ root, base, out }),
);
const cases = providerAuthCases({ root, out, phases });
const protocol = [];
const ui = [];
const manualTokenUi = [];
let callbackWorkerIsolation;
let googleSdkContract;
let site;
let idp;
let siteTls;
let siteSpki;
let primaryError;
async function prepareOrigin(services) {
  if (site) return;
  siteTls = retainProviderAuthTls(out, services.openbao.tls);
  siteSpki = services.openbao.spki;
  await phases.run("static-origin", async () => {
    site = await startProviderAuthOrigin({
      ...deployment,
      tls: siteTls.directory,
      base,
    });
  });
  const redirectUri = `${site.origin}${base}auth/native-connector.html`;
  await phases.run("issuer", async () => {
    idp = await startProviderIssuer({
      root,
      redirectUri,
      tls: siteTls.directory,
    });
  });
}

function launchCaseBrowser(services) {
  const spki = [
    ...new Set([siteSpki, services.openbao.spki, services.vault.spki]),
  ].join(",");
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM,
    headless: true,
    env: {
      ...process.env,
      NO_PROXY: `${process.env.NO_PROXY ?? ""},${deployment.hostname}`,
      no_proxy: `${process.env.NO_PROXY ?? ""},${deployment.hostname}`,
    },
    args: [
      "--no-sandbox",
      `--host-resolver-rules=MAP ${deployment.hostname} 127.0.0.1`,
      `--proxy-bypass-list=${deployment.hostname}`,
      `--ignore-certificate-errors-spki-list=${spki}`,
    ],
  });
}

async function verifyCase(browser, services, label, device) {
  const redirectUri = `${site.origin}${base}auth/native-connector.html`;
  if (label === "desktop") {
    callbackWorkerIsolation = await phases.run("callback-worker", () =>
      proveCallbackWorkerIsolation({ browser, dist: deployment.dist, base }),
    );
    for (const [name, service] of Object.entries(services))
      protocol.push(
        await phases.run(`protocol-${name}`, () =>
          proveRealProviderGrant({ bao: service, idp, redirectUri, browser }),
        ),
      );
  }
  ui.push(
    await phases.run(`${label}-oauth`, () =>
      providerAuthBrowserJourney({
        browser,
        services,
        idp,
        site,
        base,
        out,
        label,
        device,
      }),
    ),
  );
  manualTokenUi.push(
    await phases.run(`${label}-manual`, () =>
      proveManualProviderTokens({
        browser,
        services,
        idp,
        site,
        base,
        label,
        device,
      }),
    ),
  );
  if (label === "phone")
    googleSdkContract = await phases.run("google-sdk", () =>
      runProviderAuthGoogleContract({ root, out, browser }),
    );
}

async function runCase(services, label, device) {
  await prepareOrigin(services);
  const redirectUri = `${site.origin}${base}auth/native-connector.html`;
  await phases.run(`configure-${label}`, async () => {
    for (const service of Object.values(services))
      await configureOpenBao(service, idp, {
        origin: site.origin,
        redirectUri,
      });
  });
  let browser;
  let caseError;
  try {
    await phases.run(`browser-${label}`, async () => {
      browser = await launchCaseBrowser(services);
    });
    await verifyCase(browser, services, label, device);
  } catch (error) {
    caseError = error;
    throw error;
  } finally {
    await closeProviderAuthResources([browser], caseError);
  }
}

try {
  for (const [label, device] of [
    ["desktop", { viewport: { width: 1366, height: 1000 } }],
    ["phone", phoneContext({ width: 390, height: 844 })],
  ])
    await phases.run(`${label}-case`, () =>
      cases.run(label, ({ services }) => runCase(services, label, device)),
    );
  await site.close();
  site = undefined;
  const s3Out = path.join(out, "s3-browser");
  await phases.run("s3", () =>
    execFileSync(
      process.execPath,
      [path.join(root, "apps/pages/scripts/provider-s3-browser.mjs")],
      {
        cwd: root,
        env: {
          ...process.env,
          PROVIDER_S3_DIST: deployment.dist,
          PROVIDER_S3_SITE_TLS: siteTls.directory,
          PROVIDER_S3_OUT: s3Out,
        },
        stdio: "inherit",
        timeout: 240000,
      },
    ),
  );
  const s3 = JSON.parse(
    fs.readFileSync(path.join(s3Out, "receipt.json"), "utf8"),
  );
  const receipt = {
    status: "passed",
    deploymentProfile: "dedicated_origin",
    protocol,
    ui,
    manualTokenUi,
    googleSdkContract,
    callbackWorkerIsolation,
    s3,
    staticServerOriginatorRouting: false,
    providerObservations: idp.observations,
    phaseTimings: phases.file,
  };
  fs.writeFileSync(
    path.join(out, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  await closeProviderAuthResources([idp, site, siteTls], primaryError);
}
