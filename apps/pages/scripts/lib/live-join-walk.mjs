/**
 * The steps verify:live-join walks (ADR 0150), as a person takes them: the
 * owner enters, keeps a login, switches Live sessions on, names routes in
 * Settings › Live sessions › Routes and starts a session; a joiner opens the
 * link, keeps or declines the routes it names, and asks.
 */

import { doorGuest } from "./front-door.mjs";
import { SHARED_ITEM } from "./live-item-labels.mjs";
import { addCapabilities, openSettingsCategory } from "./pages-journey.mjs";

/** Every RTCPeerConnection's configuration, as the page made it. */
export const WATCH_RTC = () => {
  const Native = window.RTCPeerConnection;
  window.__rtcConfigs = [];
  window.__rtcPeers = [];
  // A subclass, not a wrapper function: it must stay a constructor.
  window.RTCPeerConnection = class extends Native {
    constructor(config) {
      super(config);
      window.__rtcConfigs.push(JSON.stringify(config ?? {}));
      window.__rtcPeers.push(this);
    }
  };
};

/**
 * A tunnel between two machines, played on one: the other side's mDNS names
 * do not resolve and nothing else routes, so the only remote candidate a
 * page keeps is one at `address` — where the other device is reachable
 * through the tunnel. Without an address hint, nothing is left to try.
 */
export const TUNNEL_ONLY = (address) => {
  const set = RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription = function (description) {
    if (!description?.sdp) return set.call(this, description);
    const sdp = description.sdp
      .split("\r\n")
      .filter(
        (line) =>
          !line.startsWith("a=candidate:") || line.split(" ")[4] === address,
      )
      .join("\r\n");
    return set.call(this, { type: description.type, sdp });
  };
};

/** Every peer connection's states, and the page's status marks: for a failure. */
export async function peerStates(page) {
  return page.evaluate(() => ({
    peers: (window.__rtcPeers ?? []).map((pc) => ({
      connection: pc.connectionState,
      ice: pc.iceConnectionState,
      gathering: pc.iceGatheringState,
      signaling: pc.signalingState,
      remote: (pc.remoteDescription?.sdp ?? "")
        .split("\r\n")
        .filter((line) => line.startsWith("a=candidate:")),
    })),
    marks: [...document.querySelectorAll("[role=img][aria-label]")].map(
      (node) => node.getAttribute("aria-label"),
    ),
  }));
}

/**
 * What each peer connection selected, once connected: local and remote type,
 * and — for a relayed local candidate — the protocol the browser spoke to its
 * TURN server (`udp`, `tcp` or `tls`).
 */
export async function selectedPairs(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const pc of window.__rtcPeers ?? []) {
      if (pc.connectionState !== "connected") continue;
      const stats = await pc.getStats();
      for (const report of stats.values()) {
        if (report.type !== "candidate-pair" || !report.nominated) continue;
        if (report.state !== "succeeded") continue;
        const local = stats.get(report.localCandidateId);
        const remote = stats.get(report.remoteCandidateId);
        out.push({
          local: local?.candidateType,
          remote: remote?.candidateType,
          relayProtocol: local?.relayProtocol,
          address: remote?.address ?? remote?.ip,
        });
      }
    }
    return out;
  });
}

export async function ownerEnters(page, { origin, base, secret }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await doorGuest(page).click();
  const create = page.getByRole("link", { name: "New item", exact: true });
  await create.first().waitFor({ timeout: 20_000 });
  await create.first().click();
  await page.getByLabel("Name", { exact: true }).fill(SHARED_ITEM.name);
  await page.getByLabel("Secret value", { exact: true }).fill(secret);
  // Unconcealed text the catalog carries: the probes check no carrier saw it.
  await page.getByRole("button", { name: "custom field" }).click();
  await page.getByLabel("Field name", { exact: true }).fill("Team");
  await page.getByLabel("Field value", { exact: true }).fill("octo");
  await page
    .getByRole("button", { name: "Save item", exact: true })
    .first()
    .click();
  await page.waitForTimeout(900);
  await addCapabilities(page, ["Live sessions"]);
}

export async function openLive(page) {
  // The tab is the capability's: it exists once its module has activated.
  // Until then the only "Live sessions" on the page is its Capabilities tile.
  const tab = page.getByRole("link", { name: "Live sessions", exact: true });
  await tab.first().waitFor({ timeout: 20_000 });
  await openSettingsCategory(page, "Live sessions");
  await page.locator("#live-routes").waitFor({ timeout: 20_000 });
  return {
    session: page.locator("#live-session"),
    routes: page.locator("#live-routes"),
  };
}

/** Clear Routes, then add what `wanted` names, through the Form. */
export async function setRoutes(page, wanted) {
  const { routes } = await openLive(page);
  await routes.getByLabel("Tailnet, VPN or LAN address").waitFor();
  for (;;) {
    const remove = routes.getByRole("button", { name: /^Remove / });
    if ((await remove.count()) === 0) break;
    await remove.first().click();
    await page.waitForTimeout(150);
  }
  for (const address of wanted.addresses ?? []) {
    await routes.getByLabel("Tailnet, VPN or LAN address").fill(address);
    await routes.getByRole("button", { name: "Add the address" }).click();
    await routes.getByText(address, { exact: true }).waitFor();
  }
  for (const server of wanted.ice ?? []) {
    await routes.getByLabel("STUN or TURN server").fill(server.url);
    if (server.username) {
      await routes.getByLabel("TURN username").fill(server.username);
      await routes.getByLabel("TURN credential").fill(server.credential);
    }
    await routes.getByRole("button", { name: "Add the server" }).click();
    await routes.getByText(server.url, { exact: true }).waitFor();
  }
  if (wanted.relay)
    await routes
      .getByRole("checkbox", { name: "Relay only, through TURN" })
      .check();
  for (const carrier of wanted.carriers ?? []) {
    await routes.getByLabel("Code carrier").selectOption(carrier.kind);
    if (carrier.kind === "broadcast") {
      await routes.getByRole("button", { name: "Add the carrier" }).click();
      continue;
    }
    await routes.getByLabel(/^Server \(/).fill(carrier.url);
    if (carrier.kind === "nats") await natsChoices(routes, carrier);
    await routes.getByRole("button", { name: "Add the carrier" }).click();
    await routes.getByText(carrier.url, { exact: true }).waitFor();
  }
}

/** A NATS server's sign-in and session route, as the Form asks them (ADR 0167). */
async function natsChoices(routes, carrier) {
  if (carrier.mint) {
    await routes.getByLabel("Sign-in", { exact: true }).selectOption("mint");
    await routes.getByLabel("Account public key").fill(carrier.mint.account);
    await routes
      .getByLabel("Account signing key")
      .fill(carrier.mint.signingKey);
  }
  if (carrier.session)
    await routes
      .getByLabel("Session over this server")
      .selectOption(carrier.session);
}

export async function startSession(
  page,
  { admission = "invite", policy = "read" } = {},
) {
  const { session } = await openLive(page);
  await session.getByLabel("Session name").fill("Team");
  await session.getByRole("checkbox", { name: "GitHub" }).check();
  await session.getByLabel("Values").selectOption(policy);
  await session.getByLabel("Who gets in").selectOption(admission);
  await session.getByRole("button", { name: "Start the live session" }).click();
  await session.getByRole("img", { name: "Live" }).waitFor();
  const code =
    admission === "invite"
      ? (await session.locator(".live-code").innerText()).trim()
      : null;
  await session.getByRole("button", { name: "Copy the link" }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  return { panel: session, code, link };
}

export async function endSession(panel) {
  await panel
    .getByRole("button", { name: "End the session for everyone" })
    .click();
  await panel.getByRole("button", { name: "End for everyone" }).click();
}

/**
 * The joiner opens the link and asks. `routes` keeps (true) or declines
 * (false) the servers the link names; null when it names none.
 */
export async function joinerAsks(page, { link, code, name, routes = null }) {
  await page.goto(link, { waitUntil: "networkidle" });
  await page
    .getByRole("heading", { level: 1, name: "Join a session" })
    .waitFor({ timeout: 20_000 });
  const apply = page.getByRole("button", { name: "Apply configuration" });
  if (await apply.isVisible().catch(() => false)) await apply.click();
  await page.getByLabel("Your name").waitFor({ timeout: 20_000 });
  if (code) await page.getByLabel("Code").fill(code.toLowerCase());
  await page.getByLabel("Your name").fill(name);
  const choice = page.getByRole("checkbox", { name: /^Through / });
  if (routes !== null) await choice.setChecked(routes);
  await page.getByRole("button", { name: "Ask to join" }).click();
  const copy = page.getByRole("button", { name: "Copy your request code" });
  await copy.waitFor({ timeout: 20_000 });
  await copy.click();
  return page.evaluate(() => navigator.clipboard.readText());
}

/**
 * The owner pastes a request by hand and lets the person in (an open
 * session lets them in by itself: `admit: false`); the reply code.
 */
export async function ownerAdmitsByHand(
  page,
  panel,
  request,
  name,
  { admit = true } = {},
) {
  await panel.getByLabel("A request code", { exact: true }).fill(request);
  await panel.getByRole("button", { name: "Read the request" }).click();
  if (admit)
    await panel.getByRole("button", { name: `Let ${name} in` }).click();
  const copy = panel.getByRole("button", {
    name: `Copy the reply code for ${name}`,
  });
  await copy.waitFor({ timeout: 20_000 });
  await copy.click();
  return page.evaluate(() => navigator.clipboard.readText());
}

export async function joinerConnects(page, reply) {
  await page.getByLabel("The owner's reply code", { exact: true }).fill(reply);
  await page.getByRole("button", { name: "Connect" }).click();
}
