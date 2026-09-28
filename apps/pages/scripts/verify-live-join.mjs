/**
 * verify:live-join — joining somebody's vault browser to browser (ADR 0148),
 * on the production origin served from dist/, in two real browser contexts.
 *
 * The owner enters as a guest, keeps one login, switches Live sessions on
 * (the real consent), and starts an invite session from Settings › Vaults.
 * The joiner — a fresh device, nothing on it — opens the link, meets the
 * front door's join consent, gives the code and a name, and asks. The owner
 * lets them in; the two browsers connect over real WebRTC; the joiner sees
 * the shared item, reveals the password on request, and loses everything
 * when the owner ends the session.
 *
 * There is no server between them. The request and reply codes go the way a
 * person sends them: copied on one screen (the context's own clipboard) and
 * pasted on the other. The walk proves nothing else was reached: no
 * WebSocket opened, no request left the app's origin, and every
 * RTCPeerConnection either page made had no ICE server (no STUN, no TURN).
 * Fails on any page error or console error.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { doorGuest } from "./lib/front-door.mjs";
import { addCapabilities, openSettingsCategory } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const DIST = path.resolve(here, "../dist");
const OUT = path.resolve(here, "../../../artifacts/live-join");
const SECRET = "correct-horse-battery-staple-2026";
fs.mkdirSync(OUT, { recursive: true });

const harness = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});
const { log, failures, check, setStep } = harness;

/** Every RTCPeerConnection's configuration, as the page made it. */
const WATCH_RTC = () => {
  const Native = window.RTCPeerConnection;
  window.__rtcConfigs = [];
  // A subclass, not a wrapper function: it must stay a constructor.
  window.RTCPeerConnection = class extends Native {
    constructor(config) {
      super(config);
      window.__rtcConfigs.push(JSON.stringify(config ?? {}));
    }
  };
};
const sockets = [];

// Host candidates in the clear, so two contexts on one machine can meet
// without mDNS. No ICE server is configured, so host candidates are all
// either browser offers.
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  headless: true,
  args: [
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--allow-loopback-in-peer-connection",
  ],
});

async function device(options = {}) {
  const made = await harness.newPage(browser, options);
  await made.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: ORIGIN,
  });
  await made.context.addInitScript(WATCH_RTC);
  made.page.on("websocket", (socket) => sockets.push(socket.url()));
  made.page.on("console", (message) => {
    if (message.type() === "error")
      harness.record("CONSOLE-ERROR", message.text().slice(0, 400));
  });
  return made;
}

async function shot(page, name) {
  setStep(name);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function ownerStarts(page) {
  setStep("owner-guest");
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await doorGuest(page).click();
  const create = page.getByRole("link", { name: "New item", exact: true });
  await create.first().waitFor({ timeout: 20_000 });
  await create.first().click();
  await page.getByLabel("Name", { exact: true }).fill("GitHub");
  await page.getByLabel("Username", { exact: true }).fill("octo");
  await page.getByLabel("Password", { exact: true }).fill(SECRET);
  const save = page.getByRole("button", { name: "Save item", exact: true });
  await save.first().click();
  await page.waitForTimeout(900);

  setStep("owner-consent");
  await addCapabilities(page, ["Live sessions"]);
  await openSettingsCategory(page, "Vaults");
  const panel = page.locator("#live-session");
  await panel.waitFor({ timeout: 20_000 });
  await panel.getByLabel("Session name").fill("Team");
  await panel.getByRole("checkbox", { name: "GitHub" }).check();
  await panel.getByLabel("Values").selectOption("read");
  await shot(page, "1-owner-start");
  await panel.getByRole("button", { name: "Start the live session" }).click();
  await panel.getByRole("img", { name: "Live" }).waitFor();
  const code = (await panel.locator(".live-code").innerText()).trim();
  await panel.getByRole("button", { name: "Copy the link" }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  await shot(page, "2-owner-live");
  return { panel, code, link };
}

async function clipboard(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function joinerAsks(page, link, code) {
  setStep("joiner-arrives");
  await page.goto(link, { waitUntil: "networkidle" });
  check(
    !page.url().includes("live="),
    "the link's bearer left the address bar",
  );
  await page
    .getByRole("heading", { level: 1, name: "Join a session" })
    .waitFor({ timeout: 20_000 });
  await shot(page, "3-joiner-consent");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page.getByLabel("Code").waitFor({ timeout: 20_000 });
  check(
    (await page.getByRole("img", { name: "Link in hand" }).count()) === 1,
    "the link waited in memory across the consent",
  );
  await page.getByLabel("Code").fill(code.toLowerCase());
  await page.getByLabel("Your name").fill("Ada");
  await page.getByLabel("Note").fill("from the design team");
  await shot(page, "4-joiner-ask");
  await page.getByRole("button", { name: "Ask to join" }).click();
  const copy = page.getByRole("button", { name: "Copy your request code" });
  await copy.waitFor({ timeout: 20_000 });
  await copy.click();
  await shot(page, "5-joiner-request");
  return clipboard(page);
}

try {
  const owner = await device();
  const { panel, code, link } = await ownerStarts(owner.page);
  check(
    /^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/.test(code),
    `an invite code is shown (${code})`,
  );
  check(
    link.startsWith(`${ORIGIN}${BASE}#live=v1.i.`),
    "the link opens the app root, carrying an invite session",
  );
  check(!/wss?:|stun:|turn:/.test(link), "the link names no server");

  const joiner = await device({
    device: {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    },
  });
  const jp = joiner.page;
  const request = await joinerAsks(jp, link, code);
  check(/^osl-request\./.test(request), "the joiner copied a request code");
  check(
    !request.includes("Ada") && !request.includes("v=0"),
    "the request code is sealed: no name, no offer in the clear",
  );

  setStep("owner-reads-request");
  await panel.getByLabel("A request code", { exact: true }).fill(request);
  await panel.getByRole("button", { name: "Read the request" }).click();
  const admit = panel.getByRole("button", { name: "Let Ada in" });
  await admit.waitFor({ timeout: 20_000 });
  await shot(owner.page, "6-owner-asked");
  await admit.click();
  const copyReply = panel.getByRole("button", {
    name: "Copy the reply code for Ada",
  });
  await copyReply.waitFor({ timeout: 20_000 });
  await copyReply.click();
  const reply = await clipboard(owner.page);
  check(/^osl-reply\./.test(reply), "the owner copied a reply code");
  await shot(owner.page, "7-owner-reply");

  setStep("joiner-connects");
  await jp.getByLabel("The owner's reply code", { exact: true }).fill(reply);
  await jp.getByRole("button", { name: "Connect" }).click();
  await jp
    .getByRole("img", { name: "Joined Team" })
    .waitFor({ timeout: 45_000 });
  check((await jp.getByText("octo").count()) === 1, "the open field arrived");
  check(
    (await jp.getByText(SECRET).count()) === 0,
    "no concealed value before it is asked for",
  );
  await jp.getByRole("button", { name: "Reveal GitHub Password" }).click();
  await expect(jp.getByText(SECRET)).toBeVisible({ timeout: 15_000 });
  await shot(jp, "8-joiner-revealed");
  await panel.getByRole("list", { name: "Handed out" }).waitFor();
  await shot(owner.page, "9-owner-log");

  setStep("nothing-stored");
  const stored = await jp.evaluate(
    () =>
      JSON.stringify({ ...localStorage }) +
      JSON.stringify({ ...sessionStorage }),
  );
  check(
    !stored.includes(SECRET) && !stored.includes("octo"),
    "the joiner wrote nothing it was shown",
  );

  setStep("no-third-party");
  check(
    sockets.length === 0,
    `no WebSocket was opened (${sockets.join(", ")})`,
  );
  const external = log.filter((entry) => entry.kind === "external-request");
  check(
    external.length === 0,
    `no request left the origin (${external.map((e) => e.detail).join(", ")})`,
  );
  for (const [who, page] of [
    ["owner", owner.page],
    ["joiner", jp],
  ]) {
    const configs = await page.evaluate(() => window.__rtcConfigs);
    check(
      configs.length > 0 &&
        configs.every((config) => JSON.parse(config).iceServers.length === 0),
      `the ${who}'s peer connection had no ICE server (${configs.join(" ")})`,
    );
  }

  setStep("owner-ends");
  await panel
    .getByRole("button", { name: "End the session for everyone" })
    .click();
  await jp
    .getByRole("img", { name: "The session ended" })
    .waitFor({ timeout: 15_000 });
  check(
    (await jp.getByText(SECRET).count()) === 0,
    "ending dropped the revealed value",
  );
  check(
    (await jp.getByText("octo").count()) === 0,
    "ending dropped the catalog",
  );
  await shot(jp, "10-joiner-ended");
} catch (error) {
  failures.push(
    `[${log.at(-1)?.step ?? "?"}] ${error instanceof Error ? error.message : error}`,
  );
} finally {
  await browser.close();
}

for (const entry of log)
  if (entry.kind === "PAGE-ERROR" || entry.kind === "CONSOLE-ERROR")
    failures.push(`[${entry.step}] ${entry.kind} ${entry.detail}`);
fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
for (const entry of log)
  if (entry.kind === "PASS") console.log(`PASS ${entry.detail}`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED — artifacts in ${OUT}`);
