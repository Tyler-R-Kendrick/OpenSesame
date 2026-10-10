/**
 * The steps verify:live-join walks (ADR 0150), as a person takes them: the
 * owner enters, keeps a login, switches Live sessions on, names routes in
 * Settings › Live sessions › Routes and starts a session; a joiner opens the
 * link, keeps or declines the routes it names, and asks.
 */

import { doorGuest } from "./front-door.mjs";
import { SHARED_ITEM } from "./live-item-labels.mjs";
import { addCapabilities, openSettingsCategory } from "./pages-journey.mjs";

// The WebRTC instrumentation the walks read, kept with the RTC helpers.
export {
  TUNNEL_ONLY,
  WATCH_RTC,
  peerStates,
  probeChannels,
  selectedPairs,
} from "./live-rtc.mjs";

/**
 * Every text the page hands the clipboard, and whether the browser took it.
 * The app's own `writeText` call still reaches the browser's clipboard and
 * hears its real answer; the walk reads the code from here, not back off
 * the clipboard, because only Chromium lets a test read it (WebKit wants a
 * person's paste) and in Firefox the clipboard is the whole browser's, so a
 * read could meet another context's copy.
 */
export const COPY_WATCH = () => {
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) return;
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
 */
export async function copyFrom(page, key) {
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
  return copyFrom(page, copy);
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
  return copyFrom(page, copy);
}

export async function joinerConnects(page, reply) {
  await page.getByLabel("The owner's reply code", { exact: true }).fill(reply);
  await page.getByRole("button", { name: "Connect" }).click();
}
