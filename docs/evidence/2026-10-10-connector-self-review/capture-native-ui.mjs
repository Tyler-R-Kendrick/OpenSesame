/** Two production builds, actual native forms; no provider credentials or auth fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { phoneContext } from "../../../apps/pages/scripts/lib/mobile-contract.mjs";
import {
  nativeEnableConnections,
  nativeVisit,
} from "../../../apps/pages/scripts/lib/native-browser-catalog-journey.mjs";
import { sealWithPin } from "../../../apps/pages/scripts/lib/pages-journey.mjs";
import { createHarness } from "../../../apps/pages/scripts/lib/static-origin-harness.mjs";

const out = path.dirname(fileURLToPath(import.meta.url));
const rawOut = path.resolve(
  process.argv[4] ?? path.join(os.tmpdir(), "connector-review-native-ui"),
);
fs.mkdirSync(rawOut, { recursive: true });
const origin = "https://tyler-r-kendrick.github.io";
const base = "/OpenSesame/";

async function captureForm(page, providerId, name, phase, device) {
  await nativeVisit(page, base, `connections/${providerId}`);
  await page.getByRole("heading", { name, exact: true }).waitFor();
  await page.getByRole("group", { name: `${name} configuration` }).waitFor();
  const head = page.locator(".conn-settings__head");
  const measurements = {
    providerId,
    phase,
    device,
    header: await head.innerText(),
    docsUrl: await head
      .getByRole("link", { name: "Docs" })
      .getAttribute("href"),
    githubAppRegistrationButtons: await page
      .getByRole("button", {
        name: "Create GitHub App for this organization",
      })
      .count(),
    saveConfigurationButtons: await page
      .getByRole("button", {
        name: "Save configuration",
      })
      .count(),
    horizontalOverflow: await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  };
  assert.equal(measurements.githubAppRegistrationButtons, 0);
  assert.equal(measurements.saveConfigurationButtons, 0);
  assert.equal(measurements.horizontalOverflow, false);
  await page.screenshot({
    path: path.join(rawOut, `${phase}-${device}-${providerId}.png`),
    fullPage: false,
    animations: "disabled",
  });
  return measurements;
}

async function captureBuild(dist, phase) {
  const harness = createHarness({ dist, origin, base, out });
  const browser = await harness.launch({ args: ["--no-sandbox"] });
  const measurements = [];
  try {
    for (const [label, device] of [
      ["desktop", { viewport: { width: 1366, height: 1000 } }],
      ["phone", phoneContext({ width: 390, height: 844 })],
    ]) {
      const { page, context } = await harness.newPage(browser, { device });
      await page.goto(`${origin}${base}`);
      await sealWithPin(page);
      await nativeEnableConnections(page, base);
      await nativeVisit(page, base, "settings/general");
      await page.getByRole("button", { name: "Night", exact: true }).click();
      for (const [id, name] of [
        ["github", "GitHub"],
        ["s3", "S3-compatible bucket"],
      ]) {
        measurements.push(await captureForm(page, id, name, phase, label));
      }
      await context.close();
    }
    assert.deepEqual(
      harness.log.filter((row) => row.kind === "PAGE-ERROR"),
      [],
    );
  } finally {
    await browser.close();
  }
  fs.writeFileSync(
    path.join(out, `${phase}-native-ui-measurements.json`),
    `${JSON.stringify(measurements, null, 2)}\n`,
  );
}

const [phase, suppliedDist] = process.argv.slice(2);
if (!["before", "after"].includes(phase) || !suppliedDist)
  throw new Error(
    "Usage: capture-native-ui.mjs before|after /absolute/build/path",
  );
await captureBuild(path.resolve(suppliedDist), phase);
