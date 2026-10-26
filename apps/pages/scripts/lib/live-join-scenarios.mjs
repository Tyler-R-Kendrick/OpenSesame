import { opensSharedItems } from "./live-joined.mjs";
/**
 * The walks verify:live-join takes (ADR 0150): direct, each carrier and a
 * declined route (the tunnel is `live-join-tunnel.mjs`, relay only through
 * TURN `live-join-relayed.mjs`). The runner (`verify-live-join.mjs`) binds the
 * harness and launches the browsers.
 */

import { expect } from "@playwright/test";
import {
  ownerSettled,
  startMqttBroker,
  startNatsServer,
  startNostrRelay,
  startNtfyServer,
} from "./live-carriers.mjs";
import { engineOf } from "./live-engines.mjs";
import { admitAndAnswer, thisMachine } from "./live-join-addresses.mjs";
import {
  WATCH_RTC,
  admitControl,
  assertSameMachineSdpPrivacy,
  endSession,
  gatheredHosts,
  joinerAsks,
  joinerConnects,
  ownerAdmitsByHand,
  readJoinerSas,
  setRoutes,
  startSession,
} from "./live-join-walk.mjs";
import { ownerReleases } from "./live-sockets.mjs";
import { reachableBy } from "./live-tls-front.mjs";

let check;
let setStep;
let failures;
let device;
let shot;
let configs;
let SECRET;
let PHONE;
let PASSTHROUGH;
let NATS;
let NTFY;
let TLS;
let afterJoinerConnects;
/** Runs around `joinerConnects` so ICE UI can be read while connecting (P8-3). */
let whileJoinerConnects;

/**
 * The joiner's name. It has a space in it, which base64url never does, so
 * finding it in what a carrier passed means plaintext, not a coincidence
 * inside ciphertext (three letters turn up in random base64url often).
 */
const JOINER = "Ada Lovelace";

/** The runner's harness, pages and settings, for every walk below. */
export function bindWalk(walk) {
  ({
    check,
    setStep,
    failures,
    device,
    shot,
    configs,
    SECRET,
    PHONE,
    PASSTHROUGH,
    NATS,
    NTFY,
    TLS,
    afterJoinerConnects = null,
    whileJoinerConnects = null,
  } = walk);
}

/** A link's carrier topic, as both pages derive it (`carrierTopic`). */
async function topicOf(link) {
  const secret = new URL(link).hash.split(".")[3] ?? "";
  const bytes = Buffer.from(secret, "base64url");
  const key = await crypto.subtle.importKey("raw", bytes, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("osm-live-v1 topic"),
    },
    key,
    128,
  );
  return Buffer.from(bits).toString("base64url");
}

export async function direct(browser, owner) {
  setStep("direct");
  const addresses = await thisMachine();
  await setRoutes(owner.page, { addresses });
  const { panel, code, link } = await startSession(owner.page);
  check(
    !/\.[\w-]{87}\.[\w-]{43}\./.test(link),
    "with no route named, the link names no server",
  );
  await shot(owner.page, "direct-1-owner-live");
  const joiner = await device(browser, {
    ...PHONE,
    origin: owner.origin,
    dist: owner.dist,
  });
  const request = await joinerAsks(joiner.page, { link, code, name: JOINER });
  check(
    /^osl-request\./.test(request) && !request.includes(JOINER),
    "a sealed request code",
  );
  const joinerSas = await readJoinerSas(joiner.page);
  let ownerSas = "";
  const reply = await ownerAdmitsByHand(owner.page, panel, request, JOINER, {
    onSas: (sas) => {
      ownerSas = sas;
    },
  });
  check(
    /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(joinerSas) && joinerSas === ownerSas,
    `both sides show the same session SAS (joiner=${joinerSas}, owner=${ownerSas})`,
  );
  const connect = () => joinerConnects(joiner.page, reply);
  if (whileJoinerConnects) await whileJoinerConnects(joiner, connect);
  else await connect();
  if (afterJoinerConnects) await afterJoinerConnects(joiner);
  await opensSharedItems(joiner.page);
  // What a browser put in a description itself is its own doing; what the
  // app sealed beside it must be loopback or an explicitly named route
  // accepted above (live-sdp-privacy.mjs).
  const own = new Set([
    ...(await gatheredHosts(owner.page)),
    ...(await gatheredHosts(joiner.page)),
  ]);
  for (const [who, page] of [
    ["owner", owner.page],
    ["joiner", joiner.page],
  ]) {
    await assertSameMachineSdpPrivacy(page, who, {
      own,
      named: new Set(addresses),
    });
  }
  await joiner.page
    .getByRole("button", { name: "Reveal GitHub Value" })
    .click();
  await expect(joiner.page.getByText(SECRET)).toBeVisible({ timeout: 15_000 });
  await shot(joiner.page, "direct-2-joiner-revealed");
  const stored = await joiner.page.evaluate(
    () =>
      JSON.stringify({ ...localStorage }) +
      JSON.stringify({ ...sessionStorage }),
  );
  check(!stored.includes(SECRET), "the joiner wrote nothing it was shown");
  check(
    owner.sockets.length + joiner.sockets.length === 0,
    "direct: no WebSocket opened",
  );
  for (const [who, page] of [
    ["owner", owner.page],
    ["joiner", joiner.page],
  ]) {
    const made = await configs(page);
    check(
      made.length > 0 && made.every((config) => config.iceServers.length === 0),
      `direct: the ${who}'s peer connections had no ICE server`,
    );
  }
  await endSession(panel);
  await joiner.page
    .getByRole("img", { name: "The session ended" })
    .waitFor({ timeout: 15_000 });
  check(
    (await joiner.page.getByText(SECRET).count()) === 0,
    "ending dropped the value",
  );
  await joiner.context.close();
}

async function startCarrier(kind) {
  if (kind === "nostr") return startNostrRelay();
  if (kind === "mqtt") return startMqttBroker();
  if (kind === "nats") return startNatsServer(NATS);
  if (kind === "ntfy") return startNtfyServer(NTFY);
  return { kind: "broadcast", url: "", frames: [], stop: async () => {} };
}

export async function carried(browser, owner, kind) {
  setStep(`carrier-${kind}`);
  const started = await startCarrier(kind);
  if (started.missing) {
    failures.push(`[carrier-${kind}] no server binary at ${started.missing}`);
    return;
  }
  // Over TLS where the pair holds an engine that refuses plain loopback.
  const server =
    kind === "broadcast"
      ? started
      : await reachableBy(started, [owner.engine, engineOf(browser)], TLS.cert);
  if (kind === "ntfy") PASSTHROUGH.push(new URL(server.url).origin);
  try {
    // The carrier delivers codes, not the WebRTC session. These browsers
    // share a machine, whose private candidates require explicit permission.
    await setRoutes(owner.page, {
      addresses: await thisMachine(),
      carriers: [{ kind, url: server.url }],
    });
    const { panel, code, link } = await startSession(owner.page);
    await panel
      .getByRole("img", { name: /^Carrying codes: / })
      .waitFor({ timeout: 20_000 });
    const joiner =
      kind === "broadcast"
        ? { page: await owner.context.newPage(), sockets: [], context: null }
        : await device(browser, {
            ...PHONE,
            origin: owner.origin,
            dist: owner.dist,
          });
    if (kind === "broadcast") await joiner.page.addInitScript(WATCH_RTC);
    await joinerAsks(joiner.page, { link, code, name: JOINER, routes: true });
    // The request crossed on the carrier: the owner is asked with nothing pasted.
    const admit = admitControl(panel, JOINER);
    await admitAndAnswer(admit, joiner.page);
    await opensSharedItems(joiner.page);
    await shot(joiner.page, `carrier-${kind}-joined`);
    check(true, `${kind}: joined with no code pasted either way`);
    if (server.collect) await server.collect([await topicOf(link)]);
    const secret = new URL(link).hash.split(".")[3] ?? "";
    if (kind === "broadcast") {
      check(true, "broadcast: nothing left this browser to record");
    } else {
      check(
        server.frames.length > 0,
        `${kind}: the carrier passed ${server.frames.length} frames`,
      );
      const heard = server.frames.join("\n");
      for (const [what, plain] of [
        ["the name", JOINER],
        ["an SDP", "v=0"],
        ["a field", '"octo"'],
        ["the value", SECRET],
        ["the link secret", secret],
      ])
        check(!heard.includes(plain), `${kind}: the carrier never saw ${what}`);
    }
    if (kind !== "broadcast" && kind !== "ntfy") {
      const origin = new URL(server.url).host;
      check(
        joiner.sockets.length > 0 &&
          joiner.sockets.every((url) => url.includes(origin)),
        `${kind}: the joiner's sockets went to the carrier alone (${joiner.sockets.join(", ")})`,
      );
    }
    await endSession(panel);
    if (joiner.context) await joiner.context.close();
    else await joiner.page.close();
  } finally {
    PASSTHROUGH.splice(0);
    await ownerReleases(owner, server);
    await server.stop();
  }
}

export async function declined(browser, owner) {
  setStep("carrier-declined");
  const server = await reachableBy(
    await startNostrRelay(),
    [owner.engine, engineOf(browser)],
    TLS.cert,
  );
  try {
    await setRoutes(owner.page, {
      carriers: [{ kind: "nostr", url: server.url }],
    });
    const { panel, code, link } = await startSession(owner.page);
    const before = await ownerSettled(server);
    const joiner = await device(browser, {
      ...PHONE,
      origin: owner.origin,
      dist: owner.dist,
    });
    await joinerAsks(joiner.page, { link, code, name: JOINER, routes: false });
    await joiner.page.waitForTimeout(1500);
    check(joiner.sockets.length === 0, "declined: the joiner opened no socket");
    check(
      server.frames.length === before,
      "declined: the carrier heard nothing of them",
    );
    check(
      (await admitControl(panel, JOINER).count()) === 0,
      "declined: not asked",
    );
    await endSession(panel);
    await joiner.context.close();
  } finally {
    await ownerReleases(owner, server);
    await server.stop();
  }
}
