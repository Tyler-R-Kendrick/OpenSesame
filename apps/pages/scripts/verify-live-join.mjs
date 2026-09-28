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
 * Signalling rides a NIP-01 relay in this process, reached through
 * Playwright's routeWebSocket in place of the public relays, which records
 * every frame: the check that no name, code, value or link secret reached a
 * relay reads those frames. Fails on any page error or console error.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { doorGuest } from "./lib/front-door.mjs";
import { createRelay } from "./lib/nostr-relay.mjs";
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
const relay = createRelay();

// Host candidates in the clear, so two contexts on one machine can meet
// without mDNS; STUN may be unreachable here and gathering is capped.
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
  await relay.attach(made.context);
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
}

try {
  const owner = await device();
  await owner.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: ORIGIN,
  });
  const { panel, code, link } = await ownerStarts(owner.page);
  check(
    /^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/.test(code),
    `an invite code is shown (${code})`,
  );
  check(
    link.startsWith(`${ORIGIN}${BASE}#live=v1.i.`),
    "the link opens the app root, carrying an invite session",
  );

  const joiner = await device({
    device: {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    },
  });
  await joinerAsks(joiner.page, link, code);

  setStep("owner-admits");
  const admit = panel.getByRole("button", { name: "Let Ada in" });
  await admit.waitFor({ timeout: 30_000 });
  await shot(owner.page, "5-owner-asked");
  await admit.click();

  setStep("joiner-joined");
  const jp = joiner.page;
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
  await shot(jp, "6-joiner-revealed");
  await panel.getByRole("list", { name: "Handed out" }).waitFor();
  await shot(owner.page, "7-owner-log");

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

  setStep("relays-blind");
  const wire = relay.frames.join("\n");
  const secretPart = new URL(link).hash.split(".")[3] ?? "";
  for (const [leak, what] of [
    [SECRET, "the password"],
    ["octo", "the username"],
    ["Ada", "the joiner's name"],
    ["design team", "the joiner's note"],
    [code, "the code"],
    [secretPart, "the link secret"],
  ])
    check(secretPart !== "" && !wire.includes(leak), `no relay saw ${what}`);
  check(
    relay.frames.length > 0,
    `the relay carried the signalling (${relay.frames.length} frames)`,
  );

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
  await shot(jp, "8-joiner-ended");
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
