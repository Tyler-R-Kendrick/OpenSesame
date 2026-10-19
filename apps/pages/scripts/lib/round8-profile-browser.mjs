/**
 * Round 8 install-profile evidence: the browser and the harness.
 *
 * Every dist is served under the real Pages origin by the shared static
 * harness; pages opened here get clipboard access and a pageerror log so a
 * failed walk says what the build did, not just where the walk stopped.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { BASE, ORIGIN, SHOT_ROOT, log } from "./round8-profile-plan.mjs";
import { createHarness } from "./static-origin-harness.mjs";

export function requireChromium() {
  const binary = process.env.PLAYWRIGHT_CHROMIUM;
  if (!binary) throw new Error("PLAYWRIGHT_CHROMIUM is unset");
  try {
    fs.accessSync(binary, fs.constants.X_OK);
  } catch {
    throw new Error(`PLAYWRIGHT_CHROMIUM is not executable: ${binary}`);
  }
  return binary;
}

export function launchBrowser() {
  return chromium.launch({
    executablePath: requireChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

export function harnessFor(dist) {
  return createHarness({
    dist,
    origin: ORIGIN,
    base: BASE,
    out: path.join(SHOT_ROOT, "harness"),
  });
}

export async function openPage(harness, browser, device) {
  const opened = await harness.newPage(browser, { device });
  await opened.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: ORIGIN,
  });
  opened.page.setDefaultTimeout(25_000);
  opened.page.setDefaultNavigationTimeout(45_000);
  opened.page.on("pageerror", (error) => {
    log(`pageerror ${String(error.message || error).split("\n")[0]}`);
  });
  return opened;
}
