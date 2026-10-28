/** Production-browser catalog/credential contract. HTTP authority is explicitly synthetic. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashDistribution } from "./lib/build-provenance.mjs";
import { observeHttpFailures } from "./lib/http-failures.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { routeNativeApiAuthority } from "./lib/native-browser-api-authority.mjs";
import { nativeApiJourney } from "./lib/native-browser-api-journey.mjs";
import { nativeApiForgetJourney } from "./lib/native-browser-api-lifecycle.mjs";
import {
  nativeAzureSecretsJourney,
  routeNativeAzureSecretsAuthority,
} from "./lib/native-browser-azure-secrets.mjs";
import { nativeCasJourney } from "./lib/native-browser-cas-journey.mjs";
import {
  nativeCatalogJourney,
  nativeEnableConnections,
} from "./lib/native-browser-catalog-journey.mjs";
import { NATIVE_CANONICAL_PROVIDERS } from "./lib/native-browser-catalog-projection.mjs";
import { nativeExpectedFailures } from "./lib/native-browser-expected-failures.mjs";
import {
  NATIVE_INSTANCE_FIXTURES,
  nativeInstanceJourney,
  routeNativeInstanceAuthority,
} from "./lib/native-browser-instance-journey.mjs";
import { NATIVE_COMPLETE_API_IDS } from "./lib/native-browser-provider-fixtures.mjs";
import { sealWithPin } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.EVIDENCE_DIST ?? path.resolve(here, "..", "dist");
const origin = "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ?? "work/native-connectors",
);
if (!fs.existsSync(path.join(dist, "index.html")))
  throw new Error(
    "Build the production Pages application before the native connector journey.",
  );
fs.mkdirSync(out, { recursive: true });
const { createHash } = await import("node:crypto");
const indexSha256 = createHash("sha256")
  .update(fs.readFileSync(path.join(dist, "index.html")))
  .digest("hex");
const distSha256 = hashDistribution(dist);
const harness = createHarness({ dist, origin, base, out });
const requestedApiIds = process.env.NATIVE_API_IDS?.split(",").filter(Boolean);
const nativeApiIds = requestedApiIds ?? NATIVE_COMPLETE_API_IDS;
if (nativeApiIds.some((id) => !NATIVE_COMPLETE_API_IDS.includes(id)))
  throw new Error("NATIVE_API_IDS contains an unsupported provider ID");
const browser = await harness.launch();
const expectedFailures = [];
const results = [];
let activePage;
let activeContext;
try {
  for (const [label, device] of [
    ["desktop", { viewport: { width: 1366, height: 1000 } }],
    ["phone", phoneContext({ width: 390, height: 844 })],
  ]) {
    const { page, context } = await harness.newPage(browser, { device });
    activePage = page;
    activeContext = context;
    const authority = await routeNativeApiAuthority(context, harness);
    await routeNativeInstanceAuthority(context, authority, harness);
    await routeNativeAzureSecretsAuthority(context, authority, harness);
    expectedFailures.push(nativeExpectedFailures(harness, page, authority));
    await page.goto(`${origin}${base}`);
    await sealWithPin(page);
    await nativeEnableConnections(page, base);
    const rows = await nativeCatalogJourney(page, harness, {
      base,
      phone: label === "phone",
    });
    for (const providerId of nativeApiIds) {
      const fixture = authority.fixtures.find(
        (item) => item.providerId === providerId,
      );
      if (!fixture)
        throw new Error(`No documented protocol fixture for ${providerId}.`);
      const result = await nativeApiJourney(page, harness, authority, fixture, {
        base,
        out,
        label,
      });
      if (providerId === "linq")
        harness.check(
          result.providerId === "linq" &&
            result.connected === true &&
            result.readAfterReload === true,
          `${label}: Linq connects and lists messaging lines after encrypted cold reload`,
        );
      results.push({ ...result, layout: label });
    }
    for (const fixture of NATIVE_INSTANCE_FIXTURES)
      results.push(
        await nativeInstanceJourney(page, harness, authority, fixture, {
          base,
          out,
          label,
        }),
      );
    results.push(
      await nativeAzureSecretsJourney(page, harness, authority, {
        base,
        out,
        label,
      }),
    );
    if (label === "desktop") {
      const usable = results.find((result) => result.connected);
      const fixture = authority.fixtures.find(
        (item) => item.providerId === usable?.providerId,
      );
      if (fixture)
        await nativeCasJourney(page, context, harness, authority, fixture, {
          base,
          observe: (secondary) => {
            observeHttpFailures(secondary, harness.record);
            secondary.on("pageerror", (error) =>
              harness.record("PAGE-ERROR", String(error)),
            );
            expectedFailures.push(
              nativeExpectedFailures(harness, secondary, authority),
            );
          },
        });
      else
        harness.check(
          false,
          "a supported browser provider must exercise concurrent sealed configuration edits",
        );
    }
    for (const providerId of nativeApiIds) {
      const fixture = authority.fixtures.find(
        (item) => item.providerId === providerId,
      );
      if (
        fixture &&
        results.some(
          (result) => result.providerId === providerId && result.connected,
        )
      )
        results.push(
          await nativeApiForgetJourney(page, harness, authority, fixture, {
            base,
            label,
          }),
        );
    }
    results.push({
      label,
      catalogRows: rows.length,
      protocolCalls: authority.state.calls.length,
    });
    await context.close();
  }
} catch (error) {
  harness.failures.push(`[${harness.step()}] ${String(error)}`);
  const pages = activeContext?.pages() ?? (activePage ? [activePage] : []);
  for (const [index, page] of pages.entries()) {
    if (page.isClosed()) continue;
    const name = index === 0 ? "failure" : `failure-tab-${index + 1}`;
    try {
      fs.writeFileSync(
        path.join(out, `${name}.json`),
        `${JSON.stringify({ step: harness.step(), url: page.url() }, null, 2)}\n`,
      );
    } catch (captureError) {
      harness.record("FAILURE-CAPTURE", String(captureError));
    }
    await page
      .locator("body")
      .innerText({ timeout: 10_000 })
      .then((text) => fs.writeFileSync(path.join(out, `${name}.txt`), text))
      .catch((captureError) =>
        harness.record("FAILURE-CAPTURE", String(captureError)),
      );
    await page
      .screenshot({
        path: path.join(out, `${name}.png`),
        fullPage: false,
        animations: "disabled",
        timeout: 10_000,
      })
      .catch((captureError) =>
        harness.record("FAILURE-CAPTURE", String(captureError)),
      );
  }
} finally {
  await browser
    .close()
    .catch((closeError) =>
      harness.failures.push(`[browser cleanup] ${String(closeError)}`),
    );
}
const hard = harness.log.filter(
  (entry) =>
    [
      "LOOPBACK-REQUEST",
      "HTTP-ERROR",
      "PAGE-ERROR",
      "console-error",
      "MISSING-ASSET",
      "external-request",
    ].includes(entry.kind) &&
    expectedFailures.every((unexpected) => unexpected(entry)),
);
const hosted = harness.log.filter((entry) =>
  /api\.vercel\.com\/v1\/connect|\/api\/connect/.test(entry.detail),
);
const unconnected = results.filter((result) => result.connected === false);
const missing = nativeApiIds.flatMap((providerId) =>
  ["desktop", "phone"].flatMap((layout) => {
    const covered = results.some(
      (result) =>
        result.providerId === providerId &&
        result.layout === layout &&
        (result.coverage === "shared-ai-configuration" ||
          (result.connected && result.readAfterReload)),
    );
    return covered ? [] : [`${layout}/${providerId}`];
  }),
);
const complete =
  !requestedApiIds &&
  missing.length === 0 &&
  unconnected.length === 0 &&
  harness.failures.length === 0 &&
  hard.length === 0 &&
  hosted.length === 0;
try {
  fs.writeFileSync(
    path.join(out, "receipt.json"),
    `${JSON.stringify({ lastStep: harness.step(), casPages: harness.log.filter((entry) => entry.kind === "CAS-PAGE"), authority: "synthetic documented upstream protocol; no live credentials", provenance: { dist, indexSha256, distSha256 }, complete, missing, results, unconnected, failures: harness.failures, hard, hosted, checks: harness.log.filter((entry) => ["PASS", "FAIL"].includes(entry.kind)) }, null, 2)}\n`,
  );
} catch (captureError) {
  harness.failures.push(`[receipt capture] ${String(captureError)}`);
}
if (!complete) {
  for (const failure of harness.failures) console.error(failure);
  for (const result of unconnected)
    console.error(`UNCONNECTED: ${result.providerId}: ${result.reason}`);
  for (const id of missing) console.error(`MISSING COVERAGE: ${id}`);
  for (const entry of [...hard, ...hosted])
    console.error(`${entry.kind}: ${entry.detail}`);
  process.exitCode = 1;
} else {
  console.log(
    `ALL NATIVE BROWSER CHECKS PASSED — ${harness.log.filter((entry) => entry.kind === "PASS").length} assertions, ${NATIVE_CANONICAL_PROVIDERS.length} provider identities at desktop and phone widths`,
  );
}
