/** Production-browser catalog/credential contract. HTTP authority is explicitly synthetic. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observeHttpFailures } from "./lib/http-failures.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { routeNativeApiAuthority } from "./lib/native-browser-api-authority.mjs";
import { nativeApiJourney } from "./lib/native-browser-api-journey.mjs";
import { nativeApiForgetJourney } from "./lib/native-browser-api-lifecycle.mjs";
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
import { NATIVE_REPRESENTATIVE_API_IDS } from "./lib/native-browser-provider-fixtures.mjs";
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
const harness = createHarness({ dist, origin, base, out });
const browser = await harness.launch();
const expectedFailures = [];
const results = [];
let activePage;
try {
  for (const [label, device] of [
    ["desktop", { viewport: { width: 1366, height: 1000 } }],
    ["phone", phoneContext({ width: 390, height: 844 })],
  ]) {
    const { page, context } = await harness.newPage(browser, { device });
    activePage = page;
    const authority = await routeNativeApiAuthority(context, harness);
    await routeNativeInstanceAuthority(context, authority, harness);
    expectedFailures.push(nativeExpectedFailures(harness, page, authority));
    await page.goto(`${origin}${base}`);
    await sealWithPin(page);
    await nativeEnableConnections(page, base);
    const rows = await nativeCatalogJourney(page, harness, {
      base,
      phone: label === "phone",
    });
    for (const providerId of NATIVE_REPRESENTATIVE_API_IDS) {
      const fixture = authority.fixtures.find(
        (item) => item.providerId === providerId,
      );
      if (!fixture)
        throw new Error(`No documented protocol fixture for ${providerId}.`);
      results.push(
        await nativeApiJourney(page, harness, authority, fixture, {
          base,
          out,
          label,
        }),
      );
    }
    for (const fixture of NATIVE_INSTANCE_FIXTURES)
      results.push(
        await nativeInstanceJourney(page, harness, authority, fixture, {
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
    for (const providerId of NATIVE_REPRESENTATIVE_API_IDS) {
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
  harness.failures.push(String(error));
  if (activePage && !activePage.isClosed()) {
    fs.writeFileSync(
      path.join(out, "failure.txt"),
      await activePage.locator("body").innerText(),
    );
    await activePage
      .screenshot({
        path: path.join(out, "failure.png"),
        fullPage: false,
        animations: "disabled",
        timeout: 10_000,
      })
      .catch((captureError) =>
        harness.record("FAILURE-CAPTURE", String(captureError)),
      );
  }
} finally {
  await browser.close();
}
const hard = harness.log.filter(
  (entry) =>
    [
      "LOOPBACK-REQUEST",
      "HTTP-ERROR",
      "PAGE-ERROR",
      "console-error",
      "MISSING-ASSET",
    ].includes(entry.kind) &&
    expectedFailures.every((unexpected) => unexpected(entry)),
);
const hosted = harness.log.filter((entry) =>
  /api\.vercel\.com\/v1\/connect|\/api\/connect/.test(entry.detail),
);
fs.writeFileSync(
  path.join(out, "receipt.json"),
  `${JSON.stringify({ authority: "synthetic documented upstream protocol; no live credentials", results, failures: harness.failures, hard, hosted, checks: harness.log.filter((entry) => ["PASS", "FAIL"].includes(entry.kind)) }, null, 2)}\n`,
);
if (harness.failures.length || hard.length || hosted.length) {
  for (const failure of harness.failures) console.error(failure);
  for (const entry of [...hard, ...hosted])
    console.error(`${entry.kind}: ${entry.detail}`);
  process.exitCode = 1;
} else {
  console.log(
    `ALL NATIVE BROWSER CHECKS PASSED — ${harness.log.filter((entry) => entry.kind === "PASS").length} assertions, ${NATIVE_CANONICAL_PROVIDERS.length} provider identities at desktop and phone widths`,
  );
}
