/**
 * The steps verify:live-join walks (ADR 0150), as a person takes them: the
 * owner seals a vault with a PIN, keeps a login, switches Live sessions on,
 * names routes in Share › Advanced and starts a session; a joiner opens the
 * link, keeps or declines the routes it names, and asks.
 */

import { SHARED_ITEM } from "./live-item-labels.mjs";
import { answerAddresses, namesSameMachine } from "./live-join-addresses.mjs";
import { PIN, addCapabilities, sealWithPin } from "./pages-journey.mjs";

// The WebRTC instrumentation the walks read, kept with the RTC helpers.
export {
  TUNNEL_ONLY,
  WATCH_RTC,
  peerStates,
  probeChannels,
  selectedPairs,
} from "./live-rtc.mjs";
export {
  assertSameMachineSdpPrivacy,
  gatheredHosts,
} from "./live-sdp-privacy.mjs";

/**
 * Every text the page hands the clipboard, and whether the browser took it.
 * The app's own `writeText` call still reaches the browser's clipboard and
 * hears its real answer; the walk reads the code from here, not back off
 * the clipboard, because only Chromium lets a test read it (WebKit wants a
 * person's paste) and in Firefox the clipboard is the whole browser's, so a
 * read could meet another context's copy.
 *
 * Idempotent: a driver that installs it as an init script and `copyFrom`,
 * which installs it again on the page it is handed, wrap `writeText` once.
 */
export const COPY_WATCH = () => {
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText || window.__copies) return;
  const native = clipboard.writeText.bind(clipboard);
  window.__copies = [];
  clipboard.writeText = (text) => {
    const entry = { text: String(text), ok: null, error: null };
    window.__copies.push(entry);
    return native(text).then(
      () => {
        entry.ok = true;
      },
      (error) => {
        entry.ok = false;
        entry.error = String(error);
        throw error;
      },
    );
  };
};

/**
 * Press a copy key and return what it copied, once the browser took it. A
 * copy the browser refused fails the walk: that is a person left without the
 * code.
 *
 * It installs the watch itself, so a driver that never added `COPY_WATCH` as an
 * init script (verify-live-local-pair, the netns and session walks) still
 * works: the watch is in place before the click, and a copy made before the
 * install is not one this call was waiting for.
 */
export async function copyFrom(page, key) {
  await page.evaluate(COPY_WATCH);
  const before = await page.evaluate(() => window.__copies?.length ?? 0);
  await key.click();
  const entry = await (
    await page.waitForFunction(
      (at) => {
        const made = window.__copies?.[at];
        return made && made.ok !== null ? made : null;
      },
      before,
      { timeout: 10_000 },
    )
  ).jsonValue();
  if (!entry.ok)
    throw new Error(`the browser refused the copy: ${entry.error}`);
  return entry.text;
}

export async function ownerEnters(page, { origin, base, secret }) {
  // Seed real wall time before the PIN ceremony advances Playwright timers.
  await page.clock.install({ time: new Date() });
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
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
  const session = page.getByRole("dialog", {
    name: "Share personal",
    exact: true,
  });
  if (!(await session.isVisible())) {
    const key = page
      .getByRole("button", {
        name: /^(Share this vault|Sharing — live session)$/,
      })
      .locator("visible=true");
    await key.waitFor({ timeout: 20_000 });
    await key.click();
  }
  await session.waitFor({ timeout: 20_000 });
  const advanced = session.locator("details.live-advanced");
  if ((await advanced.getAttribute("open")) === null)
    await advanced.getByText("Advanced", { exact: true }).click();
  const back = session.getByRole("button", {
    name: "Back to routes",
    exact: true,
  });
  if (await back.isVisible()) await back.click();
  const routes = session.locator("#live-routes");
  await routes.waitFor({ timeout: 20_000 });
  return { session, routes };
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
  await namesSameMachine(routes, wanted.addresses ?? []);
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
  await session.getByLabel("Share", { exact: true }).selectOption("items");
  await session
    .getByRole("checkbox", {
      name: `${SHARED_ITEM.name} · personal`,
      exact: true,
    })
    .check();
  await session.getByLabel("Values").selectOption(policy);
  await session.getByLabel("Who gets in").selectOption(admission);
  await session
    .getByRole("button", { name: "Share this vault", exact: true })
    .click({ timeout: 20_000 });
  await session.getByRole("img", { name: "Live", exact: true }).waitFor();
  const code =
    admission === "invite"
      ? (await session.locator(".live-code").innerText()).trim()
      : null;
  const link = await copyFrom(
    page,
    session.getByRole("button", { name: "Copy the link" }),
  );
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
 * (false) the servers the link names; null when it names none. `peerTrust`,
 * when set, is pasted into Peer trust signal before the ask. The carrier road
 * returns null: its request travels automatically, with no manual copy needed.
 */
export async function joinerAsks(
  page,
  { link, code, name, routes = null, peerTrust = "" },
) {
  await page.goto(link, { waitUntil: "networkidle" });
  await page
    .getByRole("heading", { level: 1, name: "Join a session" })
    .waitFor({ timeout: 20_000 });
  const apply = page.getByRole("button", { name: "Apply configuration" });
  if (await apply.isVisible().catch(() => false)) await apply.click();
  await page.getByLabel("Your name").waitFor({ timeout: 20_000 });
  if (code) await page.getByLabel("Code").fill(code.toLowerCase());
  await page.getByLabel("Your name").fill(name);
  const pin = page.getByLabel("Your vault PIN", { exact: true });
  if (await pin.isVisible()) {
    await pin.fill(PIN);
    await page.getByLabel("Confirm PIN", { exact: true }).fill(PIN);
    await page
      .getByLabel("I understand this vault cannot be recovered.", {
        exact: true,
      })
      .check();
  }
  if (peerTrust || routes !== null) {
    const advanced = page.locator("details.live-advanced").filter({
      has: page.getByLabel("Peer trust signal", { exact: true }),
    });
    if ((await advanced.getAttribute("open")) === null)
      await advanced.locator("summary").click();
  }
  if (peerTrust) {
    await page.getByLabel("Peer trust signal", { exact: true }).fill(peerTrust);
  }
  const choice = page.getByRole("checkbox", { name: /^Pair through / });
  if (routes !== null) await choice.setChecked(routes);
  await page.getByRole("button", { name: "Ask to join" }).click();
  const copy = page.getByRole("button", { name: "Copy your join request" });
  if (routes === true) {
    const automatic = page.getByRole("img", {
      name: "The owner can see your request. Waiting for them to let you in.",
      exact: true,
    });
    // A ready carrier hides the manual packet controls. A refused carrier
    // keeps them as the fallback; both are an actual request, not the form.
    await automatic.or(copy).first().waitFor({ timeout: 20_000 });
    return null;
  }
  await copy.waitFor({ timeout: 20_000 });
  return copyFrom(page, copy);
}

const SAS_TEXT = /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/;

/** The owner's export is behind its own Peer trust signal disclosure. */
export async function openPeerTrustSignal(panel) {
  const summary = panel.getByText("Peer trust signal", { exact: true });
  const disclosure = summary.locator("..");
  await summary.waitFor();
  if ((await disclosure.getAttribute("open")) === null) await summary.click();
  return disclosure;
}

/** Read the joiner's session code after opening its Security code disclosure. */
export async function readJoinerSas(page) {
  const disclosure = page.locator("details.live-verify");
  await disclosure.waitFor();
  if ((await disclosure.getAttribute("open")) === null)
    await disclosure.getByText("Security code", { exact: true }).click();
  const sas = disclosure.locator(".live-sas");
  await sas.waitFor({ state: "visible" });
  return (await sas.innerText()).trim();
}

function escapeName(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The admit control for `name`: the SAS compare when the request carries a
 * peer block, otherwise the legacy let-in key.
 */
export function admitControl(root, name) {
  const escaped = escapeName(name);
  return root.getByRole("button", {
    name: new RegExp(`^(Yes, they match for ${escaped}|Let ${escaped} in)$`),
  });
}

async function confirmSessionSas(panel, name) {
  // The owner's fingerprint is also `.live-sas`. The session string is the
  // one on the guest row, which is what the joiner is showing.
  const text = (
    await panel
      .locator(".vault-row")
      .filter({
        has: panel.page().getByRole("button", {
          name: `Yes, they match for ${name}`,
          exact: true,
        }),
      })
      .locator(".live-sas")
      .innerText()
  ).trim();
  if (!SAS_TEXT.test(text)) {
    throw new Error(`session SAS is not readable: ${text}`);
  }
  return text;
}

/**
 * The owner pastes a request by hand and lets the person in. An open session
 * auto-admits after the asking seat is emitted (`admit: false`), so its
 * transient comparison key is not a manual admission step. Invite sessions
 * compare the displayed SAS before pressing "Yes, they match". The reply code.
 */
export async function ownerAdmitsByHand(
  page,
  panel,
  request,
  name,
  { admit = true, beforeAdmit, onSas = () => {} } = {},
) {
  await panel.getByLabel("Paste a join request", { exact: true }).fill(request);
  await panel.getByRole("button", { name: "Read the request" }).click();
  const match = panel.getByRole("button", {
    name: `Yes, they match for ${name}`,
  });
  const letIn = panel.getByRole("button", { name: `Let ${name} in` });
  const copy = panel.getByRole("button", {
    name: `Copy the reply code for ${name}`,
  });
  if (admit) {
    await match.or(letIn).first().waitFor({ timeout: 20_000 });
    await beforeAdmit?.();
    if (await match.isVisible()) {
      onSas(await confirmSessionSas(panel, name));
      await match.click();
    } else {
      await letIn.click();
    }
  } else {
    await match.or(copy).first().waitFor({ timeout: 20_000 });
    await beforeAdmit?.();
    if (await match.isVisible()) {
      onSas(await confirmSessionSas(panel, name));
      await match.click();
    }
  }
  await copy.waitFor({ timeout: 20_000 });
  return copyFrom(page, copy);
}

export async function joinerConnects(page, reply) {
  await page.getByLabel("The owner's reply code", { exact: true }).fill(reply);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await answerAddresses(page);
}
