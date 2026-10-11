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
 *    address (`TUNNEL_ONLY`), this machine's default-route address. With no
 *    address named, the browsers never connect; once the owner names the
 *    address in Routes, they do, over a candidate pair at that address —
 *    with no ICE server.
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
 * **Browsers.** The owner runs in one engine (`LIVE_OWNER`, default
 * chromium) and every walk is taken once for each joiner engine
 * (`LIVE_JOINERS`, default the owner's): chromium, firefox, webkit, the
 * builds the pinned Playwright installs (`lib/live-engines.mjs`). Each check
 * and screenshot names its pair (`firefox>webkit`). A walk an engine cannot
 * take here is not taken with it, and says so: TLS to the TURN server needs a
 * key the engine can be told to trust (Chromium alone), and the broadcast
 * carrier pairs two tabs of one browser, so it runs where the joiner is the
 * owner's engine. WebKit, as Safari, refuses a plain socket to loopback from
 * an https page, so where a pair holds it each carrier is reached through a
 * TLS front (`lib/live-tls-front.mjs`). CI runs three shards, one per owner,
 * each with all three joiners: every ordered pair, every walk.
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
import { dedicatedSite } from "./lib/live-dedicated.mjs";
import {
  NO_ROUTE_STEPS,
  engineOf,
  enginesFrom,
  lacks,
  launchEngine,
} from "./lib/live-engines.mjs";
import { bindNats, natsSession } from "./lib/live-join-nats.mjs";
import { livePages } from "./lib/live-join-pages.mjs";
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
import { openLive, ownerEnters } from "./lib/live-join-walk.mjs";
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
/** The owner's browser, and each joiner's: every walk runs once per joiner. */
const OWNER = enginesFrom(process.env.LIVE_OWNER ?? "chromium")[0];
const JOINERS = enginesFrom(process.env.LIVE_JOINERS ?? OWNER);
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
const { log, failures } = harness;
/** The pair walking now (`chromium>firefox`): every check and step names it. */
let pair = "";
const named = (what) => (pair ? `${pair} ${what}` : what);
const check = (condition, what) => harness.check(condition, named(what));
const setStep = (step) => harness.setStep(named(step));
/** Loopback carriers the walk runs itself; read by every context per request. */
const PASSTHROUGH = [];
const PHONE = {
  device: {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  },
};

const { device, shot, configs, wreckage } = livePages({
  harness,
  origin: ORIGIN,
  dist: DIST,
  out: OUT,
  passthrough: PASSTHROUGH,
  named,
});

const joined = (page) => page.getByRole("img", { name: "Joined Team" });

/** The walk's throwaway certificate, once minted: a carrier's TLS front uses it. */
const TLS = { cert: undefined };

/** A walk an engine cannot take here, said rather than skipped silently. */
const note = (what) => harness.record("NOT-TAKEN", named(what));

bindWalk({
  note,
  TLS,
  check,
  setStep,
  failures,
  device,
  shot,
  configs,
  joined,
  launch: launchEngine,
  SECRET,
  ORIGIN,
  BASE,
  PHONE,
  PASSTHROUGH,
  NATS,
  NTFY,
});
bindRelayed({
  check,
  setStep,
  failures,
  device,
  shot,
  configs,
  joined,
  PHONE,
  TLS,
});
bindNats({
  check,
  setStep,
  failures,
  device,
  shot,
  joined,
  SECRET,
  PHONE,
  TLS,
});

// A throwaway certificate for 127.0.0.1: the TLS TURN server's, and a
// carrier's TLS front where a pair needs one. Chromium trusts its public key
// alone, by flag: no blanket certificate override.
const cert = mintTurnCert(TURN);
const turnFixture = { binary: TURN, cert: cert.missing ? undefined : cert };
TLS.cert = turnFixture.cert;

/** One browser per engine, host candidates in the clear (see live-engines). */
const browsers = new Map();
for (const engine of new Set([OWNER, ...JOINERS]))
  browsers.set(
    engine,
    await launchEngine(engine, { turnCert: turnFixture.cert }),
  );

/** Every walk on the dedicated build, once with `joiner`'s browser. */
async function localWalks(own, joiner) {
  const browser = browsers.get(joiner);
  if (SCENARIOS.has("carriers"))
    for (const kind of KINDS) {
      // Two tabs of one browser: only where the joiner is the owner's engine.
      if (kind === "broadcast" && joiner !== OWNER) continue;
      await carried(browser, own, kind);
    }
  if (SCENARIOS.has("declined")) await declined(browser, own);
  if (SCENARIOS.has("relayed")) await relayed(browser, own);
  if (SCENARIOS.has("relayed-tcp"))
    await relayedOver(browser, own, "tcp", turnFixture);
  if (SCENARIOS.has("relayed-tls")) {
    const without = [OWNER, joiner].filter((e) => lacks(e, "turn-tls-trust"));
    if (without.length === 0)
      await relayedOver(browser, own, "tls", turnFixture);
    else
      note(
        `relayed-tls: ${[...new Set(without)].join(" and ")} cannot trust a throwaway key`,
      );
  }
  if (SCENARIOS.has("relayed-rest"))
    await relayedRest(browser, own, turnFixture);
  if (SCENARIOS.has("relayed-rest-wrong"))
    await relayedRest(browser, own, { ...turnFixture, wrong: true });
  for (const mode of ["always", "fallback"])
    if (SCENARIOS.has(`nats-${mode}`))
      await natsSession(browser, own, NATS, mode);
}

try {
  const owner = await device(browsers.get(OWNER));
  setStep("owner-enters");
  await ownerEnters(owner.page, { origin: ORIGIN, base: BASE, secret: SECRET });
  await openLive(owner.page);
  await shot(owner.page, `0-owner-live-settings-${OWNER}`);
  if (SCENARIOS.has("direct"))
    for (const joiner of JOINERS) {
      pair = `${OWNER}>${joiner}`;
      await direct(browsers.get(joiner), owner);
    }
  pair = "";
  // A carrier server runs on this machine, so these walks run on a build of
  // one's own (see DEDICATED_ORIGIN): the shared origin may not reach it.
  if (LOCAL_CARRIER_WALKS.some((name) => SCENARIOS.has(name))) {
    const site = dedicatedSite();
    const own = await device(browsers.get(OWNER), site);
    setStep("owner-enters-dedicated");
    await ownerEnters(own.page, {
      origin: site.origin,
      base: BASE,
      secret: SECRET,
    });
    await openLive(own.page);
    for (const joiner of JOINERS) {
      pair = `${OWNER}>${joiner}`;
      await localWalks(own, joiner);
    }
  }
} catch (error) {
  failures.push(
    `[${harness.step()}] ${error instanceof Error ? error.message : error}`,
  );
  for (const browser of browsers.values())
    await wreckage(browser, `main-${engineOf(browser)}`);
} finally {
  for (const browser of browsers.values()) await browser.close();
}
try {
  if (SCENARIOS.has("tunnel"))
    for (const joiner of JOINERS) {
      pair = `${OWNER}>${joiner}`;
      await tunnel(wreckage, OWNER, joiner);
    }
} catch (error) {
  failures.push(
    `[${harness.step()}] ${error instanceof Error ? error.message : error}`,
  );
}
pair = "";

for (const entry of log)
  if (entry.kind === "PAGE-ERROR" || entry.kind === "CONSOLE-ERROR")
    failures.push(`[${entry.step}] ${entry.kind} ${entry.detail}`);
// The browser saying ICE failed is expected only where the walk must not connect.
for (const entry of log)
  if (
    entry.kind === "BROWSER-ICE" &&
    !NO_ROUTE_STEPS.some((step) => entry.step.endsWith(step))
  )
    failures.push(`[${entry.step}] ICE failed where it should connect`);
const external = log.filter((entry) => entry.kind === "external-request");
if (external.length > 0)
  failures.push(
    `requests left the origin: ${external.map((entry) => entry.detail).join(", ")}`,
  );
fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
for (const entry of log)
  if (entry.kind === "PASS") console.log(`PASS ${entry.detail}`);
for (const entry of log)
  if (entry.kind === "NOT-TAKEN") console.log(`NOT TAKEN ${entry.detail}`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED — artifacts in ${OUT}`);
// A test server's handle can outlive its stop(); the walk is over.
process.exit(0);
