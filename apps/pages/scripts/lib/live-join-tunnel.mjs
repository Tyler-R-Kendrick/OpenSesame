/**
 * The tunnel walk verify:live-join takes (ADR 0150 §6): a tailnet or VPN
 * between two machines, played on one, with mDNS hiding on as every browser
 * ships it. The runner (`verify-live-join.mjs`) binds the harness and
 * launches the browsers.
 */

import { defaultRouteAddress, lacks } from "./live-engines.mjs";
import { answerAddresses } from "./live-join-addresses.mjs";
import {
  TUNNEL_ONLY,
  endSession,
  joinerAsks,
  joinerConnects,
  ownerAdmitsByHand,
  ownerEnters,
  selectedPairs,
  setRoutes,
  startSession,
} from "./live-join-walk.mjs";
import { joinedSession, opensSharedItems } from "./live-joined.mjs";

let check;
let setStep;
let device;
let shot;
let configs;
let joined;
let launch;
let SECRET;
let ORIGIN;
let BASE;
let PHONE;
let note;

const JOINER = "Ada Lovelace";

/** The runner's harness, pages and settings, for the tunnel walk. */
export function bindTunnel(walk) {
  ({
    check,
    setStep,
    device,
    shot,
    configs,
    joined,
    launch,
    SECRET,
    ORIGIN,
    BASE,
    PHONE,
    note,
  } = walk);
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
  const reached = await joinedSession(lost.page, 20_000).then(
    () => true,
    () => false,
  );
  check(!reached, "tunnel: with no address named, the browsers never meet");
  await shot(lost.page, "tunnel-1-no-address");
  await endSession(session.panel);
  await lost.context.close();
}

async function tunnelWith(browser, owner, init, address) {
  setStep("tunnel-address");
  await setRoutes(owner.page, { addresses: [address] });
  await shot(owner.page, "tunnel-2-routes");
  const session = await startSession(owner.page, { admission: "open" });
  check(
    !session.link.includes(address),
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
  await answerAddresses(joiner.page);
  await opensSharedItems(joiner.page);
  await joined(joiner.page).waitFor({ timeout: 45_000 });
  const pairs = await selectedPairs(joiner.page);
  check(
    pairs.some((pair) => pair.address === address),
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

/**
 * The tunnel walk, owner in `ownerEngine`, joiner in `joinerEngine`, both with
 * mDNS hiding on as every browser ships it. The tunnel address is this
 * machine's default-route address (`defaultRouteAddress`). Without it named,
 * the two never meet — except where an engine cannot hide its host address
 * (WebKit here), whose own candidate is that address: that half is not taken.
 */
export async function tunnel(wreckage, ownerEngine, joinerEngine) {
  setStep("tunnel");
  const address = await defaultRouteAddress();
  const ownerBrowser = await launch(ownerEngine, { mdns: "hidden" });
  const joinerBrowser =
    joinerEngine === ownerEngine
      ? ownerBrowser
      : await launch(joinerEngine, { mdns: "hidden" });
  const init = [[TUNNEL_ONLY, address]];
  try {
    const owner = await device(ownerBrowser, { init });
    await ownerEnters(owner.page, {
      origin: ORIGIN,
      base: BASE,
      secret: SECRET,
    });
    const shown = [ownerEngine, joinerEngine].filter((engine) =>
      lacks(engine, "mdns-hiding"),
    );
    if (shown.length === 0) await tunnelWithout(joinerBrowser, owner, init);
    else
      note(
        `tunnel-no-address: ${[...new Set(shown)].join(" and ")} cannot hide its host address`,
      );
    await tunnelWith(joinerBrowser, owner, init, address);
  } catch (error) {
    await wreckage(ownerBrowser, `tunnel-${ownerEngine}`);
    if (joinerBrowser !== ownerBrowser)
      await wreckage(joinerBrowser, `tunnel-${joinerEngine}`);
    throw error;
  } finally {
    await ownerBrowser.close();
    if (joinerBrowser !== ownerBrowser) await joinerBrowser.close();
  }
}
