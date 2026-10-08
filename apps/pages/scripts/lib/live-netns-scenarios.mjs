/**
 * The walks verify:live-netns takes (ADR 0150 §6): the owner in one network
 * namespace, the joiner in another, and a real veth between them
 * (`live-netns-topology.mjs`). What crosses is real UDP; nothing is filtered
 * or rewritten in the page, and mDNS candidate hiding is on, as in every
 * browser people run.
 */

import { startNostrRelay, startTurnServer } from "./live-carriers.mjs";
import {
  endSession,
  joinerAsks,
  joinerConnects,
  ownerAdmitsByHand,
  peerStates,
  setRoutes,
  startSession,
} from "./live-join-walk.mjs";
import { ADDRESS } from "./live-netns-topology.mjs";

const JOINER = "Ada Lovelace";

/** The deployment the owner is on: the joiner opens the same one. */
const site = (ctx) => ({ origin: ctx.owner.origin, dist: ctx.owner.dist });

/** Every peer connection's configuration, as the page made it. */
async function configs(page) {
  return (await page.evaluate(() => window.__rtcConfigs)).map((raw) =>
    JSON.parse(raw),
  );
}

/**
 * The selected pair of every connected peer: each end's kind and address.
 * One side's page can show "Joined" before the other's peer has finished
 * connecting, so this waits for a connected peer rather than sampling once.
 */
export async function pairs(page, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const found = await selected(page);
    if (found.length > 0 || Date.now() > until) return found;
    await page.waitForTimeout(250);
  }
}

function selected(page) {
  return page.evaluate(async () => {
    const end = (candidate) => ({
      type: candidate?.candidateType,
      address: candidate?.address,
      port: candidate?.port,
    });
    const out = [];
    for (const pc of window.__rtcPeers ?? []) {
      if (pc.connectionState !== "connected") continue;
      const stats = await pc.getStats();
      const chosen = [...stats.values()].filter(
        (report) =>
          report.type === "candidate-pair" &&
          report.nominated &&
          report.state === "succeeded",
      );
      for (const report of chosen)
        out.push({
          local: end(stats.get(report.localCandidateId)),
          remote: end(stats.get(report.remoteCandidateId)),
        });
    }
    return out;
  });
}

const joinedMark = (page) => page.getByRole("img", { name: "Joined Team" });
const meets = (page, ms) =>
  joinedMark(page)
    .waitFor({ timeout: ms })
    .then(
      () => true,
      () => false,
    );

/** Owner asks nobody to be let in: an open session, codes passed by hand. */
async function pairByHand(ctx, joiner, { name = JOINER } = {}) {
  const { owner } = ctx;
  const session = await startSession(owner.page, { admission: "open" });
  const request = await joinerAsks(joiner.page, { link: session.link, name });
  const reply = await ownerAdmitsByHand(
    owner.page,
    session.panel,
    request,
    name,
    { admit: false },
  );
  await joinerConnects(joiner.page, reply);
  return session;
}

function noIceServer(ctx, made, what) {
  ctx.check(
    made.length > 0 && made.every((config) => config.iceServers.length === 0),
    `${what}: no peer connection had an ICE server`,
  );
}

/** 1. No address named: mDNS names cannot resolve over the link, so no meeting. */
export async function noAddress(ctx) {
  const { check, setStep, owner } = ctx;
  setStep("no-address");
  await setRoutes(owner.page, {});
  const joiner = await ctx.device(ctx.browsers.b);
  const session = await pairByHand(ctx, joiner);
  // Sampled through the wait: the page gives up and closes the peer before
  // the end of it, and a closed peer says nothing about what it did.
  const seen = new Set();
  const watching = setInterval(async () => {
    const now = await peerStates(joiner.page).catch(() => ({ peers: [] }));
    for (const peer of now.peers) seen.add(`${peer.connection}/${peer.ice}`);
  }, 250);
  const reached = await meets(joiner.page, 20_000);
  clearInterval(watching);
  check(!reached, "no address: the browsers never meet");
  const states = await peerStates(joiner.page);
  const remote = states.peers.flatMap((peer) => peer.remote);
  const tried = [...seen];
  check(
    tried.some((state) => state.endsWith("/checking")) &&
      !tried.some((state) => /^connected|\/(connected|completed)$/.test(state)),
    `no address: the joiner tried and was never connected (saw ${tried.join(", ")})`,
  );
  const hosts = remote.filter((line) => line.includes(" typ host"));
  check(
    hosts.length > 0 &&
      hosts.every((line) => line.split(" ")[4]?.endsWith(".local")),
    `no address: the owner's host candidates reached the joiner only as mDNS names (${hosts.length})`,
  );
  const owned = await peerStates(owner.page);
  check(
    owned.peers.every((peer) => peer.connection !== "connected"),
    "no address: the owner's peer is not connected either",
  );
  await ctx.shot(joiner.page, "1-no-address-joiner");
  await endSession(session.panel);
  await joiner.context.close();
}

/** 2. The address named: candidates copied at it, and they connect over it. */
export async function withAddress(ctx) {
  const { check, setStep, owner } = ctx;
  setStep("address");
  await setRoutes(owner.page, { addresses: [ADDRESS.a] });
  await ctx.shot(owner.page, "2-routes");
  const joiner = await ctx.device(ctx.browsers.b);
  const session = await pairByHand(ctx, joiner);
  check(
    !session.link.includes(ADDRESS.a),
    "address: the owner's address is not in the link",
  );
  await joinedMark(joiner.page).waitFor({ timeout: 45_000 });
  const theirs = await pairs(joiner.page);
  check(
    theirs.length > 0 &&
      theirs.every(
        (pair) =>
          pair.remote.type === "host" && pair.remote.address === ADDRESS.a,
      ),
    `address: the joiner's selected pair ends at the named ${ADDRESS.a} (${JSON.stringify(theirs)})`,
  );
  // Chromium hides a peer-reflexive candidate's address, so the owner's end
  // is judged by kind: the joiner was learned from its checks, not hinted.
  const ours = await pairs(owner.page);
  check(
    ours.length > 0 && ours.every((pair) => pair.remote.type === "prflx"),
    `address: the owner learned the joiner from its checks (${JSON.stringify(ours)})`,
  );
  noIceServer(ctx, await configs(owner.page), "address: the owner");
  noIceServer(ctx, await configs(joiner.page), "address: the joiner");
  await ctx.shot(joiner.page, "2-joined");
  await endSession(session.panel);
  await joiner.context.close();
}

/** Plaintext nobody but the two browsers may have seen. */
function leaks(frames, link) {
  const secret = new URL(link).hash.split(".")[3] ?? "";
  const heard = frames.join("\n");
  return [JOINER, "v=0", '"octo"', secret].filter((plain) =>
    heard.includes(plain),
  );
}

/** 3. The same, with the codes carried by a Nostr relay both can reach. */
export async function carried(ctx) {
  const { check, setStep, owner } = ctx;
  setStep("carrier");
  const relay = await startNostrRelay({ host: ADDRESS.internet, tls: ctx.tls });
  try {
    await setRoutes(owner.page, {
      addresses: [ADDRESS.a],
      carriers: [{ kind: "nostr", url: relay.url }],
    });
    const { panel, code, link } = await startSession(owner.page);
    await panel
      .getByRole("img", { name: /^Carrying codes: / })
      .waitFor({ timeout: 20_000 });
    const joiner = await ctx.device(ctx.browsers.b, site(ctx));
    await joinerAsks(joiner.page, { link, code, name: JOINER, routes: true });
    const admit = panel.getByRole("button", { name: `Let ${JOINER} in` });
    await admit.waitFor({ timeout: 30_000 });
    await admit.click();
    await joinedMark(joiner.page).waitFor({ timeout: 45_000 });
    check(true, "carrier: joined with no code pasted either way");
    const made = await pairs(joiner.page);
    check(
      made.length > 0 && made.every((p) => p.remote.address === ADDRESS.a),
      `carrier: connected at the named address (${JSON.stringify(made)})`,
    );
    check(
      relay.frames.length > 0 && leaks(relay.frames, link).length === 0,
      `carrier: the relay at ${ADDRESS.internet} passed ${relay.frames.length} frames and saw no name, SDP, field or link secret`,
    );
    check(
      joiner.sockets.length > 0 &&
        joiner.sockets.every((url) => url.includes(ADDRESS.internet)),
      `carrier: the joiner's sockets went to the relay alone (${joiner.sockets.join(", ")})`,
    );
    noIceServer(ctx, await configs(joiner.page), "carrier: the joiner");
    await endSession(panel);
    await joiner.context.close();
  } finally {
    await relay.stop();
  }
}

/** 4. No route between the two at all: only TURN, relay only, relay to relay. */
export async function relayed(ctx) {
  const { check, setStep, owner, topology } = ctx;
  setStep("relayed");
  const { a, b } = topology.pids;
  topology.down(a, "tn0");
  topology.down(b, "tn0");
  check(
    !topology.reach(a, b, ADDRESS.b),
    "relayed: with tn0 down, A cannot reach B at all",
  );
  const turn = await startTurnServer({ host: ADDRESS.internet });
  const relay = await startNostrRelay({ host: ADDRESS.internet, tls: ctx.tls });
  try {
    await setRoutes(owner.page, {
      ice: [
        { url: turn.url, username: turn.username, credential: turn.credential },
      ],
      relay: true,
      carriers: [{ kind: "nostr", url: relay.url }],
    });
    const { panel, code, link } = await startSession(owner.page);
    const joiner = await ctx.device(ctx.browsers.b, site(ctx));
    await joinerAsks(joiner.page, { link, code, name: JOINER, routes: true });
    const admit = panel.getByRole("button", { name: `Let ${JOINER} in` });
    await admit.waitFor({ timeout: 30_000 });
    await admit.click();
    await joinedMark(joiner.page).waitFor({ timeout: 45_000 });
    for (const [who, page] of [
      ["owner", owner.page],
      ["joiner", joiner.page],
    ]) {
      const last = (await configs(page)).at(-1);
      check(
        last?.iceTransportPolicy === "relay" &&
          last.iceServers[0]?.urls[0] === turn.url,
        `relayed: the ${who} was relay-only through ${turn.url}`,
      );
      const made = await pairs(page);
      check(
        made.length > 0 &&
          made.every(
            (p) => p.local.type === "relay" && p.remote.type === "relay",
          ),
        `relayed: the ${who} connected relay to relay (${JSON.stringify(made)})`,
      );
    }
    const { udp, tcp, tls } = await turn.stats();
    check(
      udp.authOk >= 2 && udp.allocations >= 2 && udp.authFailed === 0,
      "relayed: TURN authenticated and allocated for both actual UDP peers",
    );
    check(
      tcp.conns + tcp.bytes + tls.conns + tls.bytes === 0,
      "relayed: no TCP or TLS client traffic reached TURN",
    );
    await endSession(panel);
    await joiner.context.close();
  } finally {
    await relay.stop();
    await turn.stop();
  }
}
