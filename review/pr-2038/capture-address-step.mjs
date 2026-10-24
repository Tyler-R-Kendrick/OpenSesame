#!/usr/bin/env node
/**
 * Evidence driver (ignored scratch, never committed): the joiner's screen the
 * moment it presses Connect with an owner's reply that names this machine's
 * address (ADR 0150 §6). Two real browser contexts over real WebRTC, the
 * repository's own live-join walk helpers, the same steps on both builds:
 *
 *   node capture-address-step.mjs <before|after|current> <journey.json>
 *
 * The owner seals a PIN vault, keeps one login, switches Live sessions on,
 * names 127.0.0.1 in Routes and starts an invite session; the joiner (one
 * screen of the journey: its width and height) opens the link, gives the code
 * and asks; the owner compares the SAS and lets them in; the joiner pastes
 * the reply and presses Connect. The shot is taken there, then the joiner
 * answers the address step (Allow) where there is one and the walk records
 * whether it reached "Joined Team".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureShotsDirectory } from "../../../../../apps/pages/scripts/lib/evidence-paths.mjs";
import { phoneContext } from "../../../../../apps/pages/scripts/lib/mobile-contract.mjs";
import {
  WATCH_RTC,
  joinerAsks,
  ownerAdmitsByHand,
  ownerEnters,
  startSession,
} from "../../../../../apps/pages/scripts/lib/live-join-walk.mjs";
import { createHarness } from "../../../../../apps/pages/scripts/lib/static-origin-harness.mjs";

const [label, journeyPath] = process.argv.slice(2);
const journey = JSON.parse(fs.readFileSync(journeyPath, "utf8"));
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../../../..");
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const DIST = process.env.EVIDENCE_DIST ?? path.join(ROOT, "apps/pages/dist");
const into =
  label === "current"
    ? path.join(path.dirname(journeyPath), "current")
    : path.join(captureShotsDirectory(journeyPath), label);
fs.rmSync(into, { recursive: true, force: true });
fs.mkdirSync(into, { recursive: true });
const OUT = fs.mkdtempSync(path.join(captureShotsDirectory(journeyPath), "walk-"));
const harness = createHarness({ dist: DIST, origin: ORIGIN, base: BASE, out: OUT });
const SECRET = "correct-horse-battery-staple-2026";
const PAST =
  /^(Connecting to the owner's browser|Joined |No route to the owner's browser|Connection timed out|The session ended)/;

async function device(browser, options = {}) {
  const made = await harness.newPage(browser, { origin: ORIGIN, dist: DIST, passthrough: [], ...options });
  await made.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
  const cdp = await made.context.newCDPSession(made.page);
  await cdp.send("Browser.setPermission", {
    permission: { name: "local-network-access" },
    setting: "granted",
    origin: ORIGIN,
  });
  await made.context.addInitScript(WATCH_RTC);
  return made;
}

const marks = (scope) =>
  scope.locator("[role=img][aria-label]").evaluateAll((nodes) =>
    nodes.filter((n) => n.getClientRects().length).map((n) => n.getAttribute("aria-label")),
  );
const box = (locator) =>
  locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return `${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}`;
  });

const browser = await harness.launch({ args: ["--allow-loopback-in-peer-connection"] });
try {
  for (const screen of journey.screens) {
    console.log(`screen ${screen.name} ${screen.width}x${screen.height}`);
    const owner = await device(browser, { device: { viewport: { width: 1280, height: 900 } } });
    await ownerEnters(owner.page, { origin: ORIGIN, base: BASE, secret: SECRET });
    const { panel, code, link } = await startSession(owner.page);
    const joiner = await device(browser, {
      device: screen.desktop
        ? { viewport: { width: screen.width, height: screen.height } }
        : phoneContext({ width: screen.width, height: screen.height }),
    });
    const request = await joinerAsks(joiner.page, { link, code, name: "Robin" });
    const reply = await ownerAdmitsByHand(owner.page, panel, request, "Robin");
    const seat = joiner.page;
    await seat.getByLabel("The owner's reply code", { exact: true }).fill(reply);
    await seat.getByRole("button", { name: "Connect", exact: true }).click();
    const step = seat.locator("#live-addresses");
    await step.or(seat.getByRole("img", { name: PAST })).first().waitFor({ timeout: 45_000 });
    await seat.waitForTimeout(800);
    const shown = await step.isVisible().catch(() => false);
    console.log(`  address step drawn: ${shown}`);
    if (shown) {
      await step.scrollIntoViewIfNeeded();
      console.log(`  address step box: ${await box(step)}`);
      console.log(`  address step text: ${(await step.innerText()).replaceAll(/\s+/g, " ")}`);
      for (const key of await step.getByRole("button").all()) {
        const name = (await key.getAttribute("aria-label")) ?? (await key.innerText());
        const cls = await key.getAttribute("class");
        console.log(`  key "${name}" class="${cls}" ${await box(key)}`);
      }
    }
    console.log(`  joiner marks at the shot: ${(await marks(seat)).join(" | ")}`);
    console.log(`  joiner address at the shot: ${new URL(seat.url()).pathname}`);
    console.log(
      `  "shared item from the owner's session" notice at the shot: ${await seat.getByText(/shared items? from the owner's session/).count()}`,
    );
    console.log(
      `  focus at the shot: ${await seat.evaluate(() => {
        const el = document.activeElement;
        return el && el !== document.body
          ? `${el.tagName.toLowerCase()}#${el.id} "${el.getAttribute("aria-label") ?? ""}"`
          : "body";
      })}`,
    );
    await seat.screenshot({ path: path.join(into, `${screen.name}-after-connect.png`) });
    console.log(`  shot ${path.basename(into)}/${screen.name}-after-connect`);
    if (shown)
      await step.getByRole("button", { name: "Allow the owner's addresses", exact: true }).click();
    const joined = await seat
      .getByRole("img", { name: "Joined Team" })
      .waitFor({ timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    await seat.waitForTimeout(1200);
    console.log(`  joiner reached "Joined Team": ${joined}`);
    console.log(`  joiner marks at the end: ${(await marks(seat)).join(" | ")}`);
    console.log(`  joiner address at the end: ${new URL(seat.url()).pathname}`);
    console.log(
      `  "shared item from the owner's session" notice at the end: ${await seat.getByText(/shared items? from the owner's session/).count()}`,
    );
    await seat.screenshot({ path: path.join(into, `${screen.name}-end.png`) });
    await joiner.context.close();
    await owner.context.close();
  }
} finally {
  await browser.close();
}
const failures = harness.failures;
if (failures.length) console.log(`harness failures: ${failures.join("; ")}`);
console.log(`captures: ${into}`);
