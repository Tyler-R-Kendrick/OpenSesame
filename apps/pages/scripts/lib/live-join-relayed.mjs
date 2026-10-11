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
 * - **relayed-rest** — the owner's file holds the server's REST `secret`
 *   (coturn's `use-auth-secret`), not a name and credential, and the app mints
 *   the session's credential itself. A REST-authenticating server says what
 *   it authenticated; the link carries the minted credential and never the
 *   secret. **relayed-rest-wrong** is its negative control: the server holds
 *   a different secret, authentication fails, and the browsers never meet.
 *
 * TCP, TLS and REST are served by `live-turn` (pion/turn), which counts what
 * each transport saw. A relay-to-relay pair says nothing of how the client reached
 * the server, so every walk also asks the server: the transport it was named
 * for authenticated and allocated for both peers, and no client traffic
 * reached any other transport.
 */

import { createHmac, randomBytes } from "node:crypto";
import { startNostrRelay, startTurnServer } from "./live-carriers.mjs";
import { engineOf, lacks } from "./live-engines.mjs";
import {
  backToForm,
  linkRoutes,
  readProfileFile,
  saveProfileFile,
} from "./live-join-profile.mjs";
import {
  endSession,
  joinerAsks,
  selectedPairs,
  setRoutes,
  startSession,
} from "./live-join-walk.mjs";
import { reachableBy } from "./live-tls-front.mjs";
import { startLiveTurn } from "./live-turn.mjs";

let check;
let setStep;
let failures;
let device;
let shot;
let configs;
let joined;
let PHONE;
let TLS;

/** How long a walk that must not connect waits before it says so. */
const NO_ROUTE_MS = 10_000;

/** The owner names the server and the carrier through the Routes Form. */
function formRoutes(page, route, carrier) {
  return setRoutes(page, {
    ice: [route],
    relay: true,
    carriers: [{ kind: "nostr", url: carrier }],
  });
}

/** As in live-join-scenarios: a space no base64url carries. */
const JOINER = "Ada Lovelace";

/** The runner's harness and pages, for every walk below. */
export function bindRelayed(walk) {
  ({ check, setStep, failures, device, shot, configs, joined, PHONE, TLS } =
    walk);
}

/** Both peers were relay-only through `url`, and met relay to relay over `protocol`. */
export async function checkPeers(pages, { url, protocol, label }) {
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
    // WebKit names no relayProtocol: there the server's own account
    // (`checkServer`, or node-turn's one UDP listener) says how it was reached.
    const unnamed = lacks(engineOf(page.context().browser()), "relay-protocol");
    check(
      pairs.length > 0 &&
        pairs.every(
          (pair) =>
            pair.relayProtocol === protocol ||
            (unnamed && pair.relayProtocol === undefined),
        ),
      `${label}: the ${who} reached the TURN server over ${protocol}${unnamed ? " (by the server's account)" : ""} (${JSON.stringify(pairs)})`,
    );
  }
}

/** The server's own account: only the named transport carried the clients. */
export async function checkServer(turn, transport, label) {
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

/**
 * The walk itself, for whichever server the owner named. `prepare` sets the
 * owner's routes (the carrier's address in hand); `afterwards` runs once
 * joined, with both pages and the link the owner copied. A walk that must not
 * connect says so (`connects: false`) and gets a short wait, not a long one.
 */
async function through(browser, owner, label, hooks) {
  const { prepare, afterwards, connects = true } = hooks;
  setStep(label);
  const relay = await reachableBy(
    await startNostrRelay(),
    [owner.engine, engineOf(browser)],
    TLS.cert,
  );
  try {
    await prepare(relay.url);
    await shot(owner.page, `${label}-1-routes`);
    const { panel, code, link } = await startSession(owner.page);
    const joiner = await device(browser, {
      ...PHONE,
      origin: owner.origin,
      dist: owner.dist,
    });
    await joinerAsks(joiner.page, { link, code, name: JOINER, routes: true });
    const admit = panel.getByRole("button", { name: `Let ${JOINER} in` });
    await admit.waitFor({ timeout: 30_000 });
    await admit.click();
    if (connects) {
      await joined(joiner.page).waitFor({ timeout: 45_000 });
      await shot(joiner.page, `${label}-2-joined`);
    } else {
      const reached = await joined(joiner.page)
        .waitFor({ timeout: NO_ROUTE_MS })
        .then(
          () => true,
          () => false,
        );
      check(!reached, `${label}: the browsers never met`);
      await shot(joiner.page, `${label}-2-not-joined`);
    }
    await afterwards(
      [
        ["owner", owner.page],
        ["joiner", joiner.page],
      ],
      link,
    );
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
    await through(browser, owner, "relayed", {
      prepare: (carrier) => formRoutes(owner.page, route, carrier),
      afterwards: (pages) =>
        checkPeers(pages, { url: turn.url, protocol: "udp", label: "relayed" }),
    });
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
    await through(browser, owner, label, {
      prepare: (carrier) => formRoutes(owner.page, route, carrier),
      afterwards: async (pages) => {
        await checkPeers(pages, { url, protocol: transport, label });
        await checkServer(turn, transport, label);
      },
    });
  } finally {
    await turn.stop();
  }
}

/** Type the profile into its file, save it, then read it back from a fresh open. */
async function saveProfile(page, profile, label) {
  await saveProfileFile(page, profile);
  // Away to the Form and back: the editor mounts again and reads the store.
  const routes = await backToForm(page);
  await routes.getByText(profile.ice[0].urls[0], { exact: true }).waitFor();
  const stored = await readProfileFile(page);
  const [want] = profile.ice;
  const [have] = stored.ice ?? [];
  check(
    have?.secret === want.secret && stored.relay === true,
    `${label}: the file saved, and read back holding the server's secret`,
  );
}

/** What the link, the peers and the server say of a REST-minted credential. */
async function checkMinted(pages, link, { secret, url, turn, label }) {
  const minted = linkRoutes(link)?.ice?.[0];
  check(
    /^\d+:osl$/.test(minted?.username ?? ""),
    `${label}: the link carries a minted credential (${minted?.username})`,
  );
  const expected = createHmac("sha1", secret)
    .update(minted?.username ?? "")
    .digest("base64");
  check(
    minted?.credential === expected,
    `${label}: its credential is the HMAC-SHA1 of its username under the secret`,
  );
  const seen = [link];
  for (const [, page] of pages) seen.push(JSON.stringify(await configs(page)));
  check(
    !("secret" in (minted ?? {})) &&
      seen.every((text) => !text.includes(secret)),
    `${label}: neither the link nor a peer connection carries the secret`,
  );
  await checkPeers(pages, { url, protocol: "udp", label });
  await checkServer(turn, "udp", label);
}

/** Authentication failed and nothing was allocated: what a wrong secret must do. */
async function checkRefused(turn, label) {
  const { udp } = await turn.stats();
  check(
    udp.authFailed >= 1 && udp.authOk === 0 && udp.allocations === 0,
    `${label}: the server refused every authentication (${JSON.stringify(udp)})`,
  );
}

/**
 * TURN REST: the secret is written in the profile file, the app mints the
 * credential. `wrong` gives the server a different secret: the negative control.
 */
export async function relayedRest(browser, owner, { binary, wrong = false }) {
  const label = wrong ? "relayed-rest-wrong" : "relayed-rest";
  const secret = randomBytes(16).toString("hex");
  const turn = await startLiveTurn(binary, {
    restSecret: wrong ? randomBytes(16).toString("hex") : secret,
  });
  if (turn.missing) {
    failures.push(`[${label}] no live-turn binary at ${turn.missing}`);
    return;
  }
  try {
    const url = turn.urls.udp;
    await through(browser, owner, label, {
      connects: !wrong,
      prepare: (carrier) =>
        saveProfile(
          owner.page,
          {
            ice: [{ urls: [url], secret }],
            relay: true,
            carriers: [{ kind: "nostr", url: carrier }],
          },
          label,
        ),
      afterwards: (pages, link) =>
        wrong
          ? checkRefused(turn, label)
          : checkMinted(pages, link, { secret, url, turn, label }),
    });
  } finally {
    await turn.stop();
  }
}
