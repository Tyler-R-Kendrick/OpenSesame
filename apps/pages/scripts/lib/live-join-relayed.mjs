/**
 * The relay-only walks verify:live-join takes (ADR 0150 §6): the owner names
 * one TURN server in Routes and turns "Relay only, through TURN" on, a Nostr
 * carrier passes the codes, and both browsers meet through the relay alone.
 * One walk per way to reach the server, because each is a different road:
 *
 * - **relayed** — `turn:host:port?transport=udp`, node-turn on loopback.
 * - **relayed-tcp** — `turn:host:port?transport=tcp`, the road through a
 *   firewall that lets only TCP out.
 * - **relayed-tls** — `turns:host:port?transport=tcp`, the road through a
 *   tunnel or port 443. The certificate is self-signed; Chromium is told to
 *   trust its public key and nothing else.
 *
 * TCP and TLS are served by `live-turn` (pion/turn), which counts what each
 * transport saw. A relay-to-relay pair says nothing of how the client reached
 * the server, so every walk also asks the server: the transport it was named
 * for authenticated and allocated for both peers, and no client traffic
 * reached any other transport.
 */

import { startNostrRelay, startTurnServer } from "./live-carriers.mjs";
import {
  endSession,
  joinerAsks,
  selectedPairs,
  setRoutes,
  startSession,
} from "./live-join-walk.mjs";
import { startLiveTurn } from "./live-turn.mjs";

let check;
let setStep;
let failures;
let device;
let shot;
let configs;
let joined;
let PHONE;

/** As in live-join-scenarios: a space no base64url carries. */
const JOINER = "Ada Lovelace";

/** The runner's harness and pages, for every walk below. */
export function bindRelayed(walk) {
  ({ check, setStep, failures, device, shot, configs, joined, PHONE } = walk);
}

/** Both peers were relay-only through `url`, and met relay to relay over `protocol`. */
async function checkPeers(pages, { url, protocol, label }) {
  for (const [who, page] of pages) {
    const last = (await configs(page)).at(-1);
    check(
      last?.iceTransportPolicy === "relay" &&
        last.iceServers[0]?.urls[0] === url,
      `${label}: the ${who}'s peer connection was relay-only through the TURN server`,
    );
    const pairs = await selectedPairs(page);
    check(
      pairs.length > 0 &&
        pairs.every(
          (pair) => pair.local === "relay" && pair.remote === "relay",
        ),
      `${label}: the ${who} connected relay to relay (${JSON.stringify(pairs)})`,
    );
    check(
      pairs.length > 0 &&
        pairs.every((pair) => pair.relayProtocol === protocol),
      `${label}: the ${who} reached the TURN server over ${protocol} (${JSON.stringify(pairs)})`,
    );
  }
}

/** The server's own account: only the named transport carried the clients. */
async function checkServer(turn, transport, label) {
  const seen = await turn.stats();
  const mine = seen[transport];
  check(
    mine.authOk >= 2 && mine.allocations >= 2 && mine.authFailed === 0,
    `${label}: the server authenticated and allocated for both peers over ${transport} (${JSON.stringify(mine)})`,
  );
  if (transport === "tls")
    check(mine.hellos >= 2, `${label}: both peers began a TLS handshake`);
  for (const [name, other] of Object.entries(seen)) {
    if (name === transport) continue;
    check(
      other.packets + other.conns + other.bytes + other.allocations === 0,
      `${label}: no client traffic reached the ${name} listener`,
    );
  }
}

/** The walk itself, for whichever server the owner named. */
async function through(browser, owner, label, route, afterwards) {
  setStep(label);
  const relay = await startNostrRelay();
  try {
    await setRoutes(owner.page, {
      ice: [route],
      relay: true,
      carriers: [{ kind: "nostr", url: relay.url }],
    });
    await shot(owner.page, `${label}-1-routes`);
    const { panel, code, link } = await startSession(owner.page);
    const joiner = await device(browser, PHONE);
    await joinerAsks(joiner.page, { link, code, name: JOINER, routes: true });
    const admit = panel.getByRole("button", { name: `Let ${JOINER} in` });
    await admit.waitFor({ timeout: 30_000 });
    await admit.click();
    await joined(joiner.page).waitFor({ timeout: 45_000 });
    await shot(joiner.page, `${label}-2-joined`);
    await afterwards([
      ["owner", owner.page],
      ["joiner", joiner.page],
    ]);
    await endSession(panel);
    await joiner.context.close();
    await setRoutes(owner.page, {});
  } finally {
    await relay.stop();
  }
}

/** UDP, through node-turn: the road with no firewall in it. */
export async function relayed(browser, owner) {
  const turn = await startTurnServer();
  try {
    const route = {
      url: turn.url,
      username: turn.username,
      credential: turn.credential,
    };
    await through(browser, owner, "relayed", route, (pages) =>
      checkPeers(pages, { url: turn.url, protocol: "udp", label: "relayed" }),
    );
  } finally {
    await turn.stop();
  }
}

/** TCP or TLS, through live-turn, which says which transport it was reached on. */
export async function relayedOver(browser, owner, transport, { binary, cert }) {
  const label = `relayed-${transport}`;
  const turn = await startLiveTurn(binary, { cert });
  if (turn.missing) {
    failures.push(`[${label}] no live-turn binary at ${turn.missing}`);
    return;
  }
  try {
    const url = turn.urls[transport];
    if (!url) {
      failures.push(`[${label}] live-turn has no ${transport} listener`);
      return;
    }
    const route = {
      url,
      username: turn.username,
      credential: turn.credential,
    };
    await through(browser, owner, label, route, async (pages) => {
      await checkPeers(pages, { url, protocol: transport, label });
      await checkServer(turn, transport, label);
    });
  } finally {
    await turn.stop();
  }
}
