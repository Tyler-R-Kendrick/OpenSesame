/**
 * verify:live-join — joining somebody's vault browser to browser (ADR 0150),
 * on the production origin served from dist/, in real browser contexts over
 * real WebRTC. Each scenario is a person's walk, fails on any page or
 * console error, and says what else was reached.
 *
 * 1. **direct** — no route named. The two codes go by hand (the context's
 *    clipboard). Proves nothing else was reached: no WebSocket, no request
 *    off the origin, and no ICE server on any peer connection.
 * 2. **tunnel** — a tailnet between two machines, played on one: mDNS
 *    hiding on, and each page keeps only remote candidates at the tunnel
 *    address (`TUNNEL_ONLY`). With no address named, the browsers never
 *    connect; once the owner names the address in Routes, they do, over a
 *    candidate pair at that address — with no ICE server.
 * 3. **carriers** — the owner names one carrier at a time: a Nostr relay, an
 *    MQTT broker (aedes), a real nats-server over WebSocket, a real ntfy
 *    server, and this browser's own tabs. The joiner keeps the link's route,
 *    asks, the owner lets them in, and nobody pastes anything. Every carrier
 *    that records frames saw no name, value, SDP or link secret. A joiner who
 *    declines the route is never heard of on it.
 * 4. **relayed**, **relayed-tcp**, **relayed-tls** — no route between the two
 *    at all but a TURN server: the owner names one in Routes, relay only, and
 *    a Nostr carrier. Both peer connections are relay-only, the pair they
 *    select is relay to relay, and nobody pastes anything. One walk for each
 *    way to reach the server: `turn:` over UDP (node-turn on loopback),
 *    `turn:` with `?transport=tcp`, and `turns:` (TLS, a throwaway
 *    self-signed certificate whose public key alone Chromium is told to
 *    trust) — the last two on `live-turn`, a real pion/turn server. Each
 *    also asks the server which transport carried the clients: the one
 *    named authenticated and allocated for both peers, and no client
 *    traffic reached the others.
 *    **relayed-rest** is the same road with a TURN REST secret: the owner
 *    types the profile file (`settings/live/transport.json`, the Form has no
 *    secret field) with a `"secret"` for the server, and the app mints the
 *    session's credential. The server authenticates both peers, the link
 *    carries the minted `<expiry>:osl` credential and never the secret.
 *    **relayed-rest-wrong** is its negative control: the server holds another
 *    secret, refuses every authentication, and the browsers never meet.
 * 5. **nats-always**, **nats-fallback** — a real nats-server in operator
 *    mode (`pnpm dev:live-nats`), named in Routes with an account signing
 *    key: each session mints its credentials, and the session itself crosses
 *    the server sealed — always, or once the browsers find no route
 *    (`lib/live-join-nats.mjs`, ADR 0167).
 *
 * The carrier, declined and relayed walks (each passes its codes through a
 * carrier on loopback) run on `dist-live-dedicated`
 * (`pnpm build:live-dedicated`), a build stamped `dedicated_origin`.
 *
 * `LIVE_NATS_SERVER` / `LIVE_NTFY_SERVER` / `LIVE_TURN_SERVER` name the
 * binaries; a missing one fails the walk unless `LIVE_CARRIERS` (or
 * `LIVE_SCENARIOS`) leaves its kind out. `LIVE_SCENARIOS` narrows the walks:
 * direct, carriers, declined, relayed, relayed-tcp, relayed-tls,
 * relayed-rest, relayed-rest-wrong, nats-always, nats-fallback, tunnel.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { dedicatedSite } from "./lib/live-dedicated.mjs";
import { bindNats, natsSession } from "./lib/live-join-nats.mjs";
import {
  bindRelayed,
  relayed,
  relayedOver,
  relayedRest,
} from "./lib/live-join-relayed.mjs";
import {
  bindWalk,
  carried,
  declined,
  direct,
  tunnel,
} from "./lib/live-join-scenarios.mjs";
import {
  WATCH_RTC,
  openLive,
  ownerEnters,
  peerStates,
  probeChannels,
} from "./lib/live-join-walk.mjs";
import { mintTurnCert } from "./lib/live-turn.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const DIST = path.resolve(here, "../dist");
const OUT = path.resolve(ROOT, "artifacts/live-join");
const SECRET = "correct-horse-battery-staple-2026";
const KINDS = (
  process.env.LIVE_CARRIERS ?? "nostr,mqtt,nats,ntfy,broadcast"
).split(",");
/** Which walks run; all of them unless narrowed while working on one. */
const SCENARIOS = new Set(
  (
    process.env.LIVE_SCENARIOS ??
    "direct,carriers,declined,relayed,relayed-tcp,relayed-tls,relayed-rest,relayed-rest-wrong,nats-always,nats-fallback,tunnel"
  ).split(","),
);
const LOCAL_CARRIER_WALKS = [
  "carriers",
  "declined",
  "relayed",
  "relayed-tcp",
  "relayed-tls",
  "relayed-rest",
  "relayed-rest-wrong",
  "nats-always",
  "nats-fallback",
];
const NATS =
  process.env.LIVE_NATS_SERVER ??
  path.join(ROOT, ".cache/mtls-fixtures/nats-server-2.11.17/nats-server");
const NTFY =
  process.env.LIVE_NTFY_SERVER ??
  path.join(ROOT, ".cache/live-fixtures/bin/ntfy");
const TURN =
  process.env.LIVE_TURN_SERVER ??
  path.join(ROOT, ".cache/live-fixtures/bin/live-turn");
fs.mkdirSync(OUT, { recursive: true });

const harness = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});
const { log, failures, check, setStep } = harness;
/** Loopback carriers the walk runs itself; read by every context per request. */
const PASSTHROUGH = [];
const PHONE = {
  device: {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  },
};

/**
 * The app is served through Playwright's router, so the page has no address
 * space of its own ("unknown") and Chrome's Local Network Access check
 * refuses its fetches to a loopback carrier whatever the person allowed.
 * On the real origin, a public page, the browser asks once and the grant
 * below is that answer; here the check is off so the grant can stand in.
 * (WebSocket carriers are not subject to it in this Chromium.)
 */
const DISABLED = ["LocalNetworkAccessChecks"];

function launch(features = [], args = []) {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    headless: true,
    args: [
      "--allow-loopback-in-peer-connection",
      `--disable-features=${[...DISABLED, ...features].join(",")}`,
      ...args,
    ],
  });
}

async function device(
  browser,
  { init = [], origin = ORIGIN, dist = DIST, ...options } = {},
) {
  const made = await harness.newPage(browser, {
    ...options,
    origin,
    dist,
    passthrough: PASSTHROUGH,
  });
  const sockets = [];
  await made.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  // A carrier on loopback (or a tailnet, or a LAN) is a local-network
  // address to a public page: Chrome asks the person first. They allow it.
  const cdp = await made.context.newCDPSession(made.page);
  await cdp.send("Browser.setPermission", {
    permission: { name: "local-network-access" },
    setting: "granted",
    origin,
  });
  await made.context.addInitScript(WATCH_RTC);
  for (const [script, arg] of init)
    await made.context.addInitScript(script, arg);
  made.page.on("websocket", (socket) => sockets.push(socket.url()));
  made.page.on("console", (message) => {
    if (message.type() === "error")
      harness.record("CONSOLE-ERROR", message.text().slice(0, 400));
    else if (process.env.LIVE_CONSOLE)
      harness.record("console", message.text().slice(0, 400));
  });
  return { ...made, sockets, origin, dist };
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

/** On a failure, every open page as it stood. */
async function wreckage(browser, label) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  for (const [at, page] of pages.entries())
    await page
      .screenshot({ path: path.join(OUT, `failed-${label}-${at + 1}.png`) })
      .catch(() => {});
  await probeChannels(pages);
  for (const [at, page] of pages.entries()) {
    const states = await peerStates(page).catch(() => null);
    harness.record(
      "FAILED-PAGE",
      `${label}-${at + 1} ${JSON.stringify(states)}`,
    );
  }
}

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
  PASSTHROUGH,
  NATS,
  NTFY,
});
bindRelayed({ check, setStep, failures, device, shot, configs, joined, PHONE });
bindNats({ check, setStep, failures, device, shot, joined, SECRET, PHONE });

// A throwaway certificate for the TLS TURN walk, and the one flag that lets
// Chromium's WebRTC trust its public key: no blanket certificate override.
const cert = ["relayed-tcp", "relayed-tls"].some((name) => SCENARIOS.has(name))
  ? mintTurnCert(TURN)
  : { missing: TURN };
const turnFixture = { binary: TURN, cert: cert.missing ? undefined : cert };

// Host candidates in the clear, so two contexts on one machine meet directly.
const browser = await launch(
  ["WebRtcHideLocalIpsWithMdns"],
  SCENARIOS.has("relayed-tls") && !cert.missing ? [cert.flag] : [],
);
try {
  const owner = await device(browser);
  setStep("owner-enters");
  await ownerEnters(owner.page, { origin: ORIGIN, base: BASE, secret: SECRET });
  await openLive(owner.page);
  await shot(owner.page, "0-owner-live-settings");
  if (SCENARIOS.has("direct")) await direct(browser, owner);
  // A carrier server runs on this machine, so these walks run on a build of
  // one's own (see DEDICATED_ORIGIN): the shared origin may not reach it.
  if (LOCAL_CARRIER_WALKS.some((name) => SCENARIOS.has(name))) {
    const site = dedicatedSite();
    const own = await device(browser, site);
    setStep("owner-enters-dedicated");
    await ownerEnters(own.page, {
      origin: site.origin,
      base: BASE,
      secret: SECRET,
    });
    await openLive(own.page);
    if (SCENARIOS.has("carriers"))
      for (const kind of KINDS) await carried(browser, own, kind);
    if (SCENARIOS.has("declined")) await declined(browser, own);
    if (SCENARIOS.has("relayed")) await relayed(browser, own);
    if (SCENARIOS.has("relayed-tcp"))
      await relayedOver(browser, own, "tcp", turnFixture);
    if (SCENARIOS.has("relayed-tls"))
      await relayedOver(browser, own, "tls", turnFixture);
    if (SCENARIOS.has("relayed-rest"))
      await relayedRest(browser, own, turnFixture);
    if (SCENARIOS.has("relayed-rest-wrong"))
      await relayedRest(browser, own, { ...turnFixture, wrong: true });
    for (const mode of ["always", "fallback"])
      if (SCENARIOS.has(`nats-${mode}`))
        await natsSession(browser, own, NATS, mode);
  }
} catch (error) {
  failures.push(
    `[${log.at(-1)?.step ?? "?"}] ${error instanceof Error ? error.message : error}`,
  );
  await wreckage(browser, "main");
} finally {
  await browser.close();
}
try {
  if (SCENARIOS.has("tunnel")) await tunnel(wreckage);
} catch (error) {
  failures.push(
    `[${log.at(-1)?.step ?? "?"}] ${error instanceof Error ? error.message : error}`,
  );
}

for (const entry of log)
  if (entry.kind === "PAGE-ERROR" || entry.kind === "CONSOLE-ERROR")
    failures.push(`[${entry.step}] ${entry.kind} ${entry.detail}`);
const external = log.filter((entry) => entry.kind === "external-request");
if (external.length > 0)
  failures.push(
    `requests left the origin: ${external.map((entry) => entry.detail).join(", ")}`,
  );
fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
for (const entry of log)
  if (entry.kind === "PASS") console.log(`PASS ${entry.detail}`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED — artifacts in ${OUT}`);
// A test server's handle can outlive its stop(); the walk is over.
process.exit(0);
