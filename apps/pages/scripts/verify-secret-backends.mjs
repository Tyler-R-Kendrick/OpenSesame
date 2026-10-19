/** Settings → real backend sockets/native browser APIs → local encrypted vault. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { sealWithPin } from "./lib/pages-journey.mjs";
import { encryptedBackupRoundTrip } from "./lib/secret-backend-backup-browser.mjs";
import { startBitwardenFixture } from "./lib/secret-backend-bitwarden-fixture.mjs";
import { startSecretBackendAppServer } from "./lib/secret-backend-browser-server.mjs";
import {
  backendCrud,
  connectBackend,
  disconnectBackend,
  enableBackendConnections,
  newBackendPage,
  openBackend,
  saveBackend,
} from "./lib/secret-backend-browser.mjs";
import {
  secretsManagerBrowser,
  secretsManagerEvidence,
  startBrowserSecretsManager,
} from "./lib/secret-backend-bws-browser.mjs";
import { startConnectFixture } from "./lib/secret-backend-connect-fixture.mjs";
import { browserCredentialFlow } from "./lib/secret-backend-credential-browser.mjs";
import {
  officialOnePasswordHandoff,
  offlineBackendImports,
} from "./lib/secret-backend-file-browser.mjs";
import { FIXTURE_TOKEN } from "./lib/secret-backend-fixture-http.mjs";
import {
  INFISICAL_CLIENT,
  startInfisicalFixture,
} from "./lib/secret-backend-infisical-fixture.mjs";
import { nativeConnections } from "./lib/secret-backend-native-browser.mjs";
import { coldOfflineBackendImport } from "./lib/secret-backend-offline-pwa.mjs";
import { startPasswordstateFixture } from "./lib/secret-backend-passwordstate-fixture.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(
  process.env.PAGES_VERIFY_DIST ??
    path.join(here, "../dist-secret-backends-verify"),
);
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "../../../work/secret-backends-browser"),
);
const origin = "http://localhost:41901";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const presets = JSON.parse(
  fs.readFileSync(
    path.join(here, "../../../spec/connectors/secret-backend-presets.json"),
    "utf8",
  ),
).providers;
if (!fs.existsSync(path.join(dist, "index.html")))
  throw new Error(
    `Build the declared loopback verification profile first: ${dist}`,
  );
fs.mkdirSync(out, { recursive: true });
for (const file of ["failure.png", "failure.json"])
  fs.rmSync(path.join(out, file), { force: true });
const h = createHarness({ dist, origin, base, out });
function setStep(value) {
  h.setStep(value);
  console.log(value);
}
const browser = await h.launch({ args: ["--no-sandbox"] });
const fixtures = [];
let app;
let bws;
async function snapshot(page, name) {
  await page.screenshot({
    path: path.join(out, `${name}.png`),
    fullPage: true,
  });
  fs.writeFileSync(
    path.join(out, `${name}.json`),
    JSON.stringify(
      await page.evaluate(() => ({
        text: document.body.innerText,
        fields: [
          ...document.querySelectorAll(
            "main input, main select, main textarea",
          ),
        ].map((node) => ({
          label: node.labels?.[0]?.textContent?.trim(),
          type: node.type,
          readonly: !!node.readOnly,
        })),
        overflow: document.documentElement.scrollWidth > innerWidth,
      })),
      null,
      2,
    ),
  );
}
async function inventory(page, width) {
  for (const preset of presets) {
    await openBackend(page, base, preset);
    await expect(
      page.getByLabel("Connection method", { exact: true }),
    ).toHaveValue(preset.defaultMode);
    await expect
      .poll(() =>
        page
          .getByLabel("Connection method", { exact: true })
          .locator("option")
          .evaluateAll((nodes) => nodes.map((node) => node.value)),
      )
      .toEqual(preset.modes);
    h.check(
      true,
      `${width}: ${preset.providerId} exposes its editable common configuration and declared methods`,
    );
  }
  const byo = presets.find(
    (entry) => entry.providerId === "byo-secret-backend",
  );
  await openBackend(page, base, byo);
  for (const mode of byo.modes) {
    await page
      .getByLabel("Connection method", { exact: true })
      .selectOption(mode);
    h.check(
      await page.getByLabel("Connection name", { exact: true }).isEditable(),
      `${width}: BYO composes editable ${mode} configuration`,
    );
  }
}

try {
  for (const start of [
    startConnectFixture,
    startInfisicalFixture,
    startPasswordstateFixture,
    startBitwardenFixture,
  ])
    fixtures.push(await start(origin));
  bws = await startBrowserSecretsManager();
  app = await startSecretBackendAppServer(dist, origin, base);
  for (const width of [1280, 390]) {
    const { page, context } = await newBackendPage(browser, {
      width,
      origin,
      providers: [...fixtures.map((fixture) => fixture.origin), bws.url],
      record: h.record,
    });
    setStep(`${width}-configuration-inventory`);
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await sealWithPin(page);
    await enableBackendConnections(page, base);
    await inventory(page, width);
    await nativeConnections(page, {
      width,
      fixtures,
      presets,
      base,
      origin,
      h,
      snapshot,
    });
    setStep(`${width}-official-bws-worker-wasm`);
    await secretsManagerBrowser(page, {
      base,
      server: bws,
      presets,
      width,
      check: h.check,
    });
    setStep(`${width}-local-vault`);
    await openBackend(
      page,
      base,
      presets.find((entry) => entry.providerId === "local-vault"),
    );
    await saveBackend(page);
    await connectBackend(page);
    await backendCrud(page, {
      name: `browser-local-${width}`,
      kind: "login",
      origin,
      width,
      check: h.check,
    });
    await disconnectBackend(page);
    setStep(`${width}-offline-file-import`);
    await offlineBackendImports(page, {
      base,
      origin,
      presets,
      width,
      check: h.check,
    });
    setStep(`${width}-encrypted-backup-restore`);
    await encryptedBackupRoundTrip(page, {
      browser,
      origin,
      base,
      presets,
      fixture: fixtures[0],
      width,
      record: h.record,
      check: h.check,
    });
    setStep(`${width}-official-onepassword-save`);
    await officialOnePasswordHandoff(page, {
      base,
      presets,
      width,
      check: h.check,
    });
    setStep(`${width}-native-credential-management`);
    await browserCredentialFlow(page, {
      base,
      origin,
      presets,
      width,
      check: h.check,
    });
    h.check(
      await page.evaluate(
        (values) =>
          values.every(
            (value) =>
              !JSON.stringify(Object.values(localStorage)).includes(value),
          ),
        [
          FIXTURE_TOKEN,
          INFISICAL_CLIENT.secret,
          "browser-offline-fixture-password",
        ],
      ),
      `${width}: backend credentials and imported password are absent from plaintext local storage`,
    );
    await snapshot(page, `${width}-completed`);
    await context.close();
    setStep(`${width}-installed-pwa-cold-offline-import`);
    await coldOfflineBackendImport(browser, {
      origin,
      base,
      presets,
      width,
      record: h.record,
      check: h.check,
      appServer: app,
      bws,
    });
  }
} catch (error) {
  const page = browser.contexts().at(-1)?.pages().at(-1);
  if (page) await snapshot(page, "failure");
  h.failures.push(`${h.step()}: ${error.stack ?? error}`);
} finally {
  await browser.close();
  if (app) await app.close();
  if (bws) await bws.close();
  for (const fixture of fixtures) await fixture.close();
}
const bwsAssets = h.log.filter(
  (entry) =>
    entry.kind === "bws-sdk-resource" &&
    entry.step.endsWith("-official-bws-worker-wasm"),
);
h.check(
  bwsAssets.some((entry) => entry.detail.includes(".wasm")),
  "Official BWS WASM asset was loaded by the real browser",
);
h.check(
  bwsAssets.some((entry) => entry.detail.includes("worker")),
  "Official BWS SDK executed in its emitted Vite worker",
);
for (const fixture of fixtures) {
  const operations = fixture.requests.filter(
    (request) => request.method !== "OPTIONS",
  );
  h.check(
    operations.length > 0 &&
      operations.every(
        (request) => request.credentialValid || request.publicPrelogin,
      ),
    `${fixture.name}: real socket operations used valid protocol authentication or the native public prelogin route`,
  );
  const preflights = fixture.requests.filter(
    (request) => request.method === "OPTIONS",
  );
  h.check(
    preflights.length > 0 &&
      preflights.every((request) => request.preflightAllowed),
    `${fixture.name}: actual browser CORS preflights were accepted for the declared origin`,
  );
  h.check(
    fixture.requests.every((request) => request.originAllowed),
    `${fixture.name}: every socket request carried the exact configured app origin`,
  );
  for (const method of fixture.nativePersonal
    ? ["GET", "POST"]
    : ["GET", "POST", "DELETE"])
    h.check(
      fixture.requests.some((request) => request.method === method),
      `${fixture.name}: socket received ${method}`,
    );
  h.check(
    fixture.requests.some((request) =>
      ["PUT", "PATCH"].includes(request.method),
    ),
    `${fixture.name}: socket received the protocol's real update method`,
  );
  if (fixture.nativePersonal)
    h.check(
      fixture.requests.some(
        (request) =>
          request.method === "PUT" &&
          /^\/api\/ciphers\/[^/]+\/delete$/.test(request.path),
      ),
      `${fixture.name}: native personal-vault delete uses authenticated PUT trash`,
    );
  h.failures.push(...fixture.errors);
}
for (const entry of h.log.filter((entry) =>
  [
    "PAGE-ERROR",
    "console-error",
    "HTTP-ERROR",
    "MISSING-ASSET",
    "unexpected-external-request",
    "worker-network-error",
  ].includes(entry.kind),
))
  h.failures.push(`${entry.kind}: ${entry.detail}`);
fs.writeFileSync(
  path.join(out, "results.json"),
  `${JSON.stringify({ failures: h.failures, log: h.log, fixtures: fixtures.map(({ name, origin: endpoint, requests, errors }) => ({ name, endpoint, requests, errors })), bitwardenSecretsManager: bws ? secretsManagerEvidence(bws) : null, limits: ["No hosted partner tenant credentials were used.", "Official 1Password extension/account save is not claimed.", "Browser credentials.store completion does not prove a particular third-party manager received the credential."] }, null, 2)}\n`,
);
if (h.failures.length) {
  console.error(h.failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `PASS secret backend browser configuration, real HTTP CRUD, native credentials and offline vault imports: ${out}`,
  );
