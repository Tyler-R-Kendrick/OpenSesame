/**
 * The body of verify:live-netns, run as root of the namespaces the entry
 * script made (`live-netns-topology.mjs`): build the network, start one
 * Chromium in each of two of its namespaces, and take the walks.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { WATCH_RTC, ownerEnters, peerStates } from "./live-join-walk.mjs";
import {
  carried,
  noAddress,
  relayed,
  withAddress,
} from "./live-netns-scenarios.mjs";
import { certificateFor } from "./live-netns-tls.mjs";
import { ADDRESS, buildTopology } from "./live-netns-topology.mjs";
import { createHarness } from "./static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../../..");
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const DIST = path.resolve(here, "../../dist");
const OUT = path.resolve(ROOT, "artifacts/live-netns");
const SECRET = "correct-horse-battery-staple-2026";

/**
 * The app is served through Playwright's router, so the page has no address
 * space of its own and Chrome's Local Network Access check would refuse its
 * WebSocket to a carrier on a private address whatever the person allowed;
 * on the real origin the browser asks once, and the grant in `device` is that
 * answer. mDNS hiding (`WebRtcHideLocalIpsWithMdns`) stays on, and so does
 * the rule against loopback candidates: nothing here needs either lifted.
 */
const tls = certificateFor(ADDRESS.internet);
const ARGS = [
  "--disable-features=LocalNetworkAccessChecks",
  // Only the carrier's own key is trusted (see live-netns-tls.mjs).
  `--ignore-certificate-errors-spki-list=${tls.spki}`,
];

const harness = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});
const { log, failures, check, setStep } = harness;

function launch(executablePath) {
  return chromium.launch({ executablePath, headless: true, args: ARGS });
}

async function device(browser, options = {}) {
  const made = await harness.newPage(browser, options);
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
  made.page.on("console", (message) => {
    if (message.type() === "error")
      harness.record("CONSOLE-ERROR", message.text().slice(0, 400));
    else if (process.env.LIVE_CONSOLE)
      harness.record("console", message.text().slice(0, 400));
  });
  return { ...made, sockets };
}

const shot = (page, name) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`) });

/** On a failure, every open page as it stood. */
async function wreckage(browsers) {
  for (const [who, browser] of Object.entries(browsers)) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const [at, page] of pages.entries()) {
      await page
        .screenshot({ path: path.join(OUT, `failed-${who}-${at + 1}.png`) })
        .catch(() => {});
      const states = await peerStates(page).catch(() => null);
      harness.record(
        "FAILED-PAGE",
        `${who}-${at + 1} ${JSON.stringify(states)}`,
      );
    }
  }
}

/** The network is what it claims to be, before anything is asked of it. */
function checkNetwork(topology) {
  setStep("network");
  const { a, b } = topology.pids;
  const { reach } = topology;
  check(!topology.forwarding(), "the harness forwards nothing between A and B");
  check(reach(a, b, ADDRESS.b), "A reaches B over tn0");
  check(reach(b, a, ADDRESS.a), "B reaches A over tn0");
  check(!reach(a, b, ADDRESS.bUplink), "A has no route to B's uplink address");
  check(!reach(b, a, ADDRESS.aUplink), "B has no route to A's uplink address");
  check(reach(a, 0, ADDRESS.internet), "A reaches the harness's servers");
  check(reach(b, 0, ADDRESS.internet), "B reaches the harness's servers");
  for (const [who, pid] of [
    ["A", a],
    ["B", b],
  ]) {
    const link = topology.interfaces(pid).tn0;
    check(
      link?.up && !link.multicast,
      `${who}'s tn0 is up with multicast off (${JSON.stringify(link)})`,
    );
  }
}

async function walks(topology) {
  const browsers = {};
  try {
    browsers.a = await launch(topology.chrome.a);
    browsers.b = await launch(topology.chrome.b);
    const ctx = {
      check,
      setStep,
      shot,
      device,
      topology,
      tls,
      browsers,
      owner: await device(browsers.a),
    };
    setStep("owner-enters");
    await ownerEnters(ctx.owner.page, {
      origin: ORIGIN,
      base: BASE,
      secret: SECRET,
    });
    try {
      for (const walk of [noAddress, withAddress, carried, relayed])
        await walk(ctx);
    } catch (error) {
      await wreckage(browsers);
      throw error;
    }
  } finally {
    for (const browser of Object.values(browsers)) await browser.close();
  }
}

export async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = process.env.PLAYWRIGHT_CHROMIUM || chromium.executablePath();
  const topology = await buildTopology(chrome);
  try {
    checkNetwork(topology);
    await walks(topology);
  } catch (error) {
    failures.push(
      `[${log.at(-1)?.step ?? "?"}] ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    topology.stop();
  }
  for (const entry of log)
    if (entry.kind === "PAGE-ERROR" || entry.kind === "CONSOLE-ERROR")
      failures.push(`[${entry.step}] ${entry.kind} ${entry.detail}`);
  const external = log.filter((entry) => entry.kind === "external-request");
  if (external.length > 0)
    failures.push(
      `requests left the origin: ${external.map((e) => e.detail).join(", ")}`,
    );
  fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
  for (const entry of log)
    if (entry.kind === "PASS") console.log(`PASS ${entry.detail}`);
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
    return 1;
  }
  console.log(`\nALL CHECKS PASSED — artifacts in ${OUT}`);
  return 0;
}
