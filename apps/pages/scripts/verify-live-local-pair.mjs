#!/usr/bin/env node
/**
 * Direct live join with two contexts on one runner and default Chromium mDNS
 * hiding (no `WebRtcHideLocalIpsWithMdns` disable). Proves same-machine
 * sessions connect without STUN/TURN after loopback hints are sealed in SDP.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { bindWalk, direct } from "./lib/live-join-scenarios.mjs";
import {
  WATCH_RTC,
  openLive,
  ownerEnters,
  peerStates,
} from "./lib/live-join-walk.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const DIST = path.resolve(here, "../dist");
const OUT = path.resolve(ROOT, "artifacts/live-local-pair");
const SECRET = "correct-horse-battery-staple-2026";

fs.mkdirSync(OUT, { recursive: true });

const harness = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});
const { failures, check, setStep } = harness;

const PHONE = {
  device: {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  },
};

/** LNA only — keep WebRtcHideLocalIpsWithMdns at Chromium default. */
function launch() {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    headless: true,
    args: [
      "--allow-loopback-in-peer-connection",
      "--disable-features=LocalNetworkAccessChecks",
    ],
  });
}

async function device(browser, options = {}) {
  const made = await harness.newPage(browser, {
    origin: ORIGIN,
    dist: DIST,
    passthrough: [],
    ...options,
  });
  const sockets = [];
  await made.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: ORIGIN,
  });
  const cdp = await made.context.newCDPSession(made.page);
  await cdp.send("Browser.setPermission", {
    permission: { name: "local-network-access" },
    setting: "granted",
    origin: ORIGIN,
  });
  await made.context.addInitScript(WATCH_RTC);
  made.page.on("websocket", (socket) => sockets.push(socket.url()));
  return { ...made, sockets, origin: ORIGIN, dist: DIST };
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function configs(page) {
  return (await page.evaluate(() => window.__rtcConfigs)).map((raw) =>
    JSON.parse(raw),
  );
}

const joined = (page) => page.getByRole("img", { name: "Joined Team" });

bindWalk({
  check,
  setStep,
  failures,
  device,
  shot,
  configs,
  joined,
  launch,
  SECRET,
  ORIGIN,
  BASE,
  PHONE,
  PASSTHROUGH: [],
  NATS: null,
  NTFY: null,
});

const browser = await launch();
try {
  const owner = await device(browser);
  setStep("owner-enters");
  await ownerEnters(owner.page, { origin: ORIGIN, base: BASE, secret: SECRET });
  await openLive(owner.page);
  await direct(browser, owner);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  const pages = browser.contexts().flatMap((context) => context.pages());
  for (const [at, page] of pages.entries()) {
    await shot(page, `failed-${at + 1}`).catch(() => {});
    const states = await peerStates(page).catch(() => null);
    console.error("peer states", states);
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("live-local-pair ok");
}
