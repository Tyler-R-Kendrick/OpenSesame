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
  startOpenBao,
  startProviderIssuer,
} from "../../../scripts/test/provider-auth-services.mjs";
import { providerAuthVaultFixture } from "../../../scripts/test/provider-auth-vault-fixture.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { providerAuthBrowserJourney } from "./provider-auth-browser.mjs";
import { buildProviderAuthDeployment } from "./provider-auth-build.mjs";
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
const deployment = await buildProviderAuthDeployment({ root, base, out });
const bao = await startOpenBao({ root, out });
let site;
let idp;
let browser;
let vault;
try {
  vault = await startOpenBao({
    root,
    out: path.join(out, "vault-service"),
    providerBinary: providerAuthVaultFixture(path.join(out, "fixtures")),
    providerName: "HashiCorp Vault 1.21.4",
  });
  site = await startProviderAuthOrigin({ ...deployment, tls: bao.tls, base });
  const redirectUri = `${site.origin}${base}auth/native-connector.html`;
  idp = await startProviderIssuer({ root, redirectUri, tls: bao.tls });
  await configureOpenBao(bao, idp, { origin: site.origin, redirectUri });
  await configureOpenBao(vault, idp, { origin: site.origin, redirectUri });
  browser = await chromium.launch({
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
      `--ignore-certificate-errors-spki-list=${bao.spki},${vault.spki}`,
    ],
  });
  // The scoped SPKI trust covers only the runtime-generated local fixture key;
  // provider/setup HTTPS calls validate the real generated CA and hostname.
  const callbackWorkerIsolation = await proveCallbackWorkerIsolation({
    browser,
    dist: deployment.dist,
    base,
  });
  const services = { vault, openbao: bao };
  const protocol = [];
  for (const service of Object.values(services))
    protocol.push(
      await proveRealProviderGrant({ bao: service, idp, redirectUri, browser }),
    );
  const ui = [];
  const manualTokenUi = [];
  for (const [label, device] of [
    ["desktop", { viewport: { width: 1366, height: 1000 } }],
    ["phone", phoneContext({ width: 390, height: 844 })],
  ]) {
    ui.push(
      await providerAuthBrowserJourney({
        browser,
        services,
        idp,
        site,
        base,
        out,
        label,
        device,
      }),
    );
    manualTokenUi.push(
      await proveManualProviderTokens({
        browser,
        services,
        idp,
        site,
        base,
        label,
        device,
      }),
    );
  }
  const googleSdkContract = await runProviderAuthGoogleContract({
    root,
    out,
    browser,
  });
  await site.close();
  site = undefined;
  const s3Out = path.join(out, "s3-browser");
  execFileSync(
    process.execPath,
    [path.join(root, "apps/pages/scripts/provider-s3-browser.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        PROVIDER_S3_DIST: deployment.dist,
        PROVIDER_S3_SITE_TLS: bao.tls,
        PROVIDER_S3_OUT: s3Out,
      },
      stdio: "inherit",
      timeout: 240000,
    },
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
  };
  fs.writeFileSync(
    path.join(out, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await browser?.close();
  await idp?.close();
  await site?.close();
  await vault?.close();
  await bao.close();
}
