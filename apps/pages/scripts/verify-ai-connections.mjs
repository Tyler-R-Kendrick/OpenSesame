/** Actual shared/native AI settings → browser CORS → four protocol families. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { verifyAiConnections } from "./lib/ai-connection-browser.mjs";
import { createAiConnectionHttpFixture } from "./lib/ai-connection-http-fixture.mjs";
import { createAiCompletionHarvest } from "./lib/ai-positive-completion.mjs";
import { createAiRequestLifecycle } from "./lib/ai-request-lifecycle.mjs";
import { startIdentityAppServer } from "./lib/identity-browser-server.mjs";
import { sealWithPin } from "./lib/pages-journey.mjs";
import {
  newBackendPage,
  visitBackendRoute,
} from "./lib/secret-backend-browser.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(
  process.env.PAGES_VERIFY_DIST ??
    path.join(here, "../dist-ai-connections-verify"),
);
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "../../../work/ai-connections-browser"),
);
const origin = "http://localhost:41911";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
if (!fs.existsSync(path.join(dist, "index.html")))
  throw new Error(`Build the declared AI verification profile first: ${dist}`);
fs.mkdirSync(out, { recursive: true });
const h = createHarness({ dist, origin, base, out });
const lifecycle = createAiRequestLifecycle({
  fixtureOrigin: "http://127.0.0.1:41912",
});
const completion = createAiCompletionHarvest();
let browser;
let fixture;
let app;

async function settingsComposition(page, width) {
  await visitBackendRoute(page, base, "settings/integrations");
  await expect(
    page.getByRole("heading", { name: "Integrations", exact: true }),
  ).toBeVisible();
  h.check(
    (await page.locator("#integration-local-storage").count()) === 0,
    `${width}: Integrations removes the Local storage provider group`,
  );
  h.check(
    (await page
      .getByRole("link", { name: "Local storage", exact: true })
      .count()) === 0,
    `${width}: Integrations removes the Local storage navigation entry`,
  );
  for (const name of ["Voice model", "Inference model"])
    h.check(
      (await page.getByRole("combobox", { name, exact: true }).count()) === 0,
      `${width}: ${name} is absent from Integrations`,
    );
  await visitBackendRoute(page, base, "settings/features#feature-ai");
  for (const name of ["Voice model", "Inference model"])
    await expect(
      page.getByRole("combobox", { name, exact: true }),
    ).toBeVisible();
  h.check(
    true,
    `${width}: Voice and Inference model choices compose the standard AI feature settings`,
  );
  h.check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    `${width}: standard AI feature settings fit the actual viewport`,
  );
}

async function runViewport(width) {
  h.setStep(`${width}-real-ai-configuration`);
  console.log(h.step());
  const { page, context } = await newBackendPage(browser, {
    width,
    origin,
    providers: [fixture.origin],
    record: h.record,
  });
  lifecycle.attach(context, String(width));
  try {
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await sealWithPin(page);
    await verifyAiConnections({
      page,
      base,
      fixture,
      width,
      check: h.check,
      beforeReload: async () => {
        await lifecycle.quiesce(context);
        await completion.harvest(page, () => lifecycle.document(page));
      },
    });
    await settingsComposition(page, width);
  } catch (error) {
    await page.screenshot({
      path: path.join(out, `${width}-failure.png`),
      fullPage: true,
    });
    throw error;
  } finally {
    await lifecycle.checkpoint(context);
    await completion.harvest(page, () => lifecycle.document(page));
    await context.close();
    lifecycle.finalize(context);
  }
}

try {
  app = await startIdentityAppServer(dist, origin, base);
  fixture = await createAiConnectionHttpFixture({
    appOrigin: origin,
    observer: lifecycle,
  });
  browser = await h.launch({ args: ["--no-sandbox"] });
  for (const width of [1280, 390]) await runViewport(width);
} catch (error) {
  h.failures.push(`${h.step()}: ${error.stack ?? error}`);
} finally {
  await browser?.close();
  await fixture?.close();
  await app?.close();
}
if (fixture) h.failures.push(...fixture.errors);
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
}
lifecycle.finalize();
const nativeRequests = lifecycle.snapshot();
const rawFailed = h.log.filter(
  (entry) => entry.kind === "network-failure",
).length;
if (rawFailed !== nativeRequests.nativeFailed)
  h.failures.push("raw-network-failure-ledger-mismatch");
const rawFailures = [...h.failures, ...nativeRequests.failures];
const originalStrictPassed = rawFailures.length === 0;
const functionalOperationContract = completion.evaluate(
  nativeRequests,
  fixture?.producers ?? [],
  fixture?.origin,
);
h.failures.push(...functionalOperationContract.failures);
fs.writeFileSync(
  path.join(out, "results.json"),
  `${JSON.stringify(
    {
      failures: h.failures,
      log: h.log,
      nativeRequests,
      originalStrictPassed,
      rawFailures,
      functionalOperationContract,
      completion: completion.snapshot(),
      producers: fixture?.producers,
      requests: fixture?.requests,
      preflights: fixture?.preflights,
      limits: [
        "Real protocol fixtures were used; no hosted AI partner account is claimed.",
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
    `PASS AI positive operation contract v2; original native strict passed=${originalStrictPassed}, raw failures retained: ${out}`,
  );
