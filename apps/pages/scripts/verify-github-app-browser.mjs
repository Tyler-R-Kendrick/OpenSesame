/** Static normal PWA -> independent provider sockets -> real RSA, vault backup and shared restore. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  destinationJourney,
  sourceJourney,
} from "./lib/github-app-browser-journey.mjs";
import { startGithubBrowserProvider } from "./lib/github-app-browser-provider.mjs";
import { routeGithubProvider } from "./lib/github-app-browser-routing.mjs";
import { startIdentityAppServer } from "./lib/identity-browser-server.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const phase = process.env.GITHUB_APP_VERIFY_PHASE ?? "after";
assert.ok(
  ["before", "mounted", "after"].includes(phase),
  "Declare exact browser verification phase",
);
const dist = path.resolve(
  process.env.PAGES_VERIFY_DIST ??
    path.join(here, "../dist-secret-backends-verify"),
);
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "../../../work/github-app-browser"),
);
const profile = JSON.parse(
  fs.readFileSync(path.join(dist, "security-profile.json"), "utf8"),
);
assert.equal(
  profile.profile,
  "loopback_development",
  "Use the actual declared browser verification build",
);
assert.equal(profile.canonicalOrigin, "http://localhost:41901");
const origin = profile.canonicalOrigin;
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const indexSha256 = createHash("sha256")
  .update(fs.readFileSync(path.join(dist, "index.html")))
  .digest("hex");
const receiptPath = process.env.GITHUB_APP_VERIFY_BUILD_RECEIPT;
const build = receiptPath
  ? JSON.parse(fs.readFileSync(receiptPath, "utf8"))
  : null;
if (build) {
  assert.equal(
    build.passed,
    true,
    "Bound normal artifact build actually passed",
  );
  assert.equal(
    build.indexSha256,
    indexSha256,
    "Actual artifact matches the retained build receipt",
  );
  assert.equal(build.profile.canonicalOrigin, origin);
}
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
assert.equal(
  fs.readdirSync(out).length,
  0,
  "Use a fresh output directory; preserve prior receipts",
);
const h = createHarness({ dist, origin, base, out });
function record(kind, detail) {
  h.record(kind, detail);
  fs.writeFileSync(
    path.join(out, "progress.json"),
    JSON.stringify({
      phase,
      step: h.step(),
      kind,
      detail,
      at: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
}
const provider = await startGithubBrowserProvider({ appOrigin: origin, base });
const result = {
  phase,
  scope:
    phase === "after"
      ? "full-cross-vault-recovery"
      : phase === "mounted"
        ? "mounted-restore-presentation-only"
        : "baseline-common-journey",
  passed: false,
  fullRecoveryPassed: false,
  source: {
    compiledHead: build?.compiledHead ?? process.env.GITHUB_SHA ?? null,
    runnerHead:
      process.env.GITHUB_APP_VERIFY_RUNNER_HEAD ??
      process.env.GITHUB_SHA ??
      null,
    indexSha256,
    dist,
    buildReceipt: receiptPath ?? null,
  },
  transportQualification:
    "Actual static HTTP app at its declared loopback origin. Original fixed GitHub HTTPS request boundaries are forwarded to an independent loopback HTTP provider socket. RSA/JWT, scopes, requests and ciphertext are real; actual GitHub TLS certificate/CORS deployment/live account acceptance are NOT proved. No TLS trust/web-security bypass flags, extension, app backend or injected connected state.",
  registrationQualification:
    "Actual application manifest UI, provider fixture confirmation UI, one-use conversion, real independently generated per-App RSA keys, normal sealed vault custody and installation readback; fixture account approval is not a live GitHub account registration.",
  receipts: [],
};
let browser;
let site;
const owners = new Set();
function monitor(context) {
  const errors = [];
  const expectedMissing = new Map();
  context.on("page", (page) => {
    page.on("pageerror", () => errors.push("Uncaught browser page error"));
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const url = new URL(response.url());
      const request = response.request();
      const initial =
        /^\/repos\/fixture-owner\/([^/]+)\/contents\/opensesame-vault\.backup\.json$/.exec(
          url.pathname,
        );
      const missing =
        response.status() === 404 &&
        request.method() === "GET" &&
        url.origin === "https://api.github.com" &&
        initial &&
        provider.snapshot(initial[1]).bytes === 0 &&
        url.searchParams.get("ref") === "main";
      if (missing) {
        expectedMissing.set(
          response.url(),
          (expectedMissing.get(response.url()) ?? 0) + 1,
        );
        h.record("EXPECTED-INITIAL-CONTENTS-MISSING", url.pathname);
      } else
        errors.push(
          `Unexpected HTTP ${response.status()} ${url.origin}${url.pathname}`,
        );
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const url = message.location().url;
      if (
        expectedMissing.has(url) &&
        message.text() ===
          "Failed to load resource: the server responded with a status of 404 (Not Found)"
      ) {
        expectedMissing.delete(url);
        return;
      }
      errors.push("Unexpected browser console error");
    });
  });
  return errors;
}
async function owner(width) {
  const device =
    width === 390
      ? phoneContext({ width, height: 844 })
      : { viewport: { width, height: 900 } };
  const context = await browser.newContext({
    ...device,
    serviceWorkers: "block",
  });
  const errors = monitor(context);
  const traffic = await routeGithubProvider(context, provider, {
    origin,
    record,
  });
  const page = await context.newPage();
  const current = { context, page, errors, traffic };
  owners.add(current);
  return current;
}
async function closeOwner(current) {
  current.traffic.assertClean();
  assert.equal(
    current.errors.length,
    0,
    "No unexpected console/page/HTTP error",
  );
  await current.traffic.close();
  await current.context.close();
  owners.delete(current);
}
try {
  site = await startIdentityAppServer(dist, origin, base);
  browser = await h.launch({ args: ["--no-sandbox"] });
  for (const width of [1280, 390]) {
    const options = {
      phase,
      width,
      repo: `browser-backup-${width}`,
      origin,
      base,
      fixture: provider,
      out,
      record,
    };
    h.setStep(`${phase}-${width}-source`);
    record("stage", "source setup starting");
    const sourceOwner = await owner(width);
    const source = await sourceJourney(sourceOwner, options);
    await closeOwner(sourceOwner);
    const row = {
      width,
      source: {
        snapshot: source.remote,
        restoreAvailable: source.restoreAvailable,
      },
      recovery:
        "NOT RUN: source presentation phase only; recovery-safe binding guard required",
    };
    if (phase === "after") {
      h.setStep(`after-${width}-destination`);
      record("stage", "independent destination recovery starting");
      const destination = await owner(width);
      row.recovery = await destinationJourney(destination, source, options);
      await closeOwner(destination);
    }
    result.receipts.push(row);
  }
  provider.assertClean();
  assert.equal(h.failures.length, 0, "All declared browser checks passed");
  result.passed = true;
  result.fullRecoveryPassed = phase === "after";
} catch (error) {
  result.failure = String(error?.stack ?? error).replace(
    /([?&](?:code|state|github_app_code|github_app_state)=)[^&\s]+/g,
    "$1[redacted]",
  );
  for (const current of owners) {
    if (!current.page.isClosed())
      await current.page
        .screenshot({
          path: path.join(out, `failure-${owners.size}.png`),
          fullPage: false,
        })
        .catch(() => {});
  }
  throw error;
} finally {
  for (const current of owners) {
    await current.context.close().catch(() => {});
  }
  await browser?.close();
  await site?.close();
  await provider.close();
  result.provider = provider.summary();
  result.providerRows = provider.rows;
  result.log = h.log;
  fs.writeFileSync(
    path.join(out, "receipt.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
}
