/**
 * The walks verify:live-join takes (ADR 0150): direct, a simulated tunnel,
 * each carrier and a declined route (relay only through TURN is
 * `live-join-relayed.mjs`). The runner
 * (`verify-live-join.mjs`) binds the harness and launches the browsers.
 */

import { expect } from "@playwright/test";
import {
  startMqttBroker,
  startNatsServer,
  startNostrRelay,
  startNtfyServer,
} from "./live-carriers.mjs";
import {
  TUNNEL_ONLY,
  WATCH_RTC,
  assertSameMachineSdpPrivacy,
  endSession,
  joinerAsks,
  joinerConnects,
  ownerAdmitsByHand,
  ownerEnters,
  selectedPairs,
  setRoutes,
  startSession,
} from "./live-join-walk.mjs";

let check;
let setStep;
let failures;
let device;
let shot;
let configs;
let joined;
let launch;
let SECRET;
let ORIGIN;
let BASE;
let PHONE;
let PASSTHROUGH;
let NATS;
let NTFY;

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
    joined,
    launch,
    SECRET,
    ORIGIN,
    BASE,
    PHONE,
    PASSTHROUGH,
    NATS,
    NTFY,
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
  const reply = await ownerAdmitsByHand(owner.page, panel, request, JOINER);
  await joinerConnects(joiner.page, reply);
  await joined(joiner.page).waitFor({ timeout: 45_000 });
  for (const [who, page] of [
    ["owner", owner.page],
    ["joiner", joiner.page],
  ]) {
    await assertSameMachineSdpPrivacy(page, who);
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

async function tunnelWithout(browser, owner, init) {
  setStep("tunnel-no-address");
  await setRoutes(owner.page, {});
  const session = await startSession(owner.page, { admission: "open" });
  const lost = await device(browser, {
    init,
    origin: owner.origin,
    dist: owner.dist,
  });
  const request = await joinerAsks(lost.page, {
    link: session.link,
    name: "Bo",
  });
  const reply = await ownerAdmitsByHand(
    owner.page,
    session.panel,
    request,
    "Bo",
    { admit: false },
  );
  await joinerConnects(lost.page, reply);
  const reached = await joined(lost.page)
    .waitFor({ timeout: 20_000 })
    .then(
      () => true,
      () => false,
    );
  check(!reached, "tunnel: with no address named, the browsers never meet");
  await shot(lost.page, "tunnel-1-no-address");
  await endSession(session.panel);
  await lost.context.close();
}

async function tunnelWith(browser, owner, init) {
  setStep("tunnel-address");
  await setRoutes(owner.page, { addresses: ["127.0.0.1"] });
  await shot(owner.page, "tunnel-2-routes");
  const session = await startSession(owner.page, { admission: "open" });
  check(
    !session.link.includes("127.0.0.1"),
    "the owner's address is not in the link",
  );
  const joiner = await device(browser, {
    ...PHONE,
    init,
    origin: owner.origin,
    dist: owner.dist,
  });
  const request = await joinerAsks(joiner.page, {
    link: session.link,
    name: JOINER,
  });
  const reply = await ownerAdmitsByHand(
    owner.page,
    session.panel,
    request,
    JOINER,
    { admit: false },
  );
  await joinerConnects(joiner.page, reply);
  await joined(joiner.page).waitFor({ timeout: 45_000 });
  const pairs = await selectedPairs(joiner.page);
  check(
    pairs.some((pair) => pair.address === "127.0.0.1"),
    `tunnel: connected at the named address (${JSON.stringify(pairs)})`,
  );
  const made = [
    ...(await configs(owner.page)),
    ...(await configs(joiner.page)),
  ];
  check(
    made.every((config) => config.iceServers.length === 0),
    "tunnel: no ICE server",
  );
  await shot(joiner.page, "tunnel-3-joined");
  await endSession(session.panel);
}

export async function tunnel(wreckage) {
  setStep("tunnel");
  // mDNS hiding on, as every browser ships: host addresses are .local names.
  const browser = await launch();
  const init = [[TUNNEL_ONLY, "127.0.0.1"]];
  try {
    const owner = await device(browser, { init });
    await ownerEnters(owner.page, {
      origin: ORIGIN,
      base: BASE,
      secret: SECRET,
    });
    await tunnelWithout(browser, owner, init);
    await tunnelWith(browser, owner, init);
  } catch (error) {
    await wreckage(browser, "tunnel");
    throw error;
  } finally {
    await browser.close();
  }
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
  const server = await startCarrier(kind);
  if (server.missing) {
    failures.push(`[carrier-${kind}] no server binary at ${server.missing}`);
    return;
  }
  if (kind === "ntfy") PASSTHROUGH.push(new URL(server.url).origin);
  try {
    await setRoutes(owner.page, { carriers: [{ kind, url: server.url }] });
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
    const admit = panel.getByRole("button", { name: `Let ${JOINER} in` });
    await admit.waitFor({ timeout: 30_000 });
    await admit.click();
    await joined(joiner.page).waitFor({ timeout: 45_000 });
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
    await server.stop();
  }
}

export async function declined(browser, owner) {
  setStep("carrier-declined");
  const server = await startNostrRelay();
  try {
    await setRoutes(owner.page, {
      carriers: [{ kind: "nostr", url: server.url }],
    });
    const { panel, code, link } = await startSession(owner.page);
    const before = server.frames.length;
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
      (await panel
        .getByRole("button", { name: `Let ${JOINER} in` })
        .count()) === 0,
      "declined: not asked",
    );
    await endSession(panel);
    await joiner.context.close();
  } finally {
    await server.stop();
  }
}
