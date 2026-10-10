#!/usr/bin/env node
/**
 * Every tutorial, walked end to end in a real browser (ADR 0163, ADR 0166).
 *
 * The Support sheet's Tutorials tab is the only way in: this suite lists what
 * the product offers, starts each one from its row, and gets through it with
 * Next alone — by mouse on one step and by keyboard on the next — checking on
 * every step that the card is whole and inside the screen, that Next is
 * there, that the steps are numbered 1..N with none skipped, and that the
 * control being pointed at is lit, visible, uncovered and reachable through
 * the aperture. Then it goes Back, Replays, finishes with
 * Done and checks where focus went. It does this at desktop and phone width,
 * on the shell with every optional capability switched on, and on the gates:
 * the front door, setup, sign-in, unlock and the broker and federation
 * screens each draw a help key (ADR 0166), and the gate pass starts every
 * tutorial a gate offers from that key, on the real screen. It also leaves a
 * tour with Escape from the card and from the lit control, and makes the move
 * an action step waits for through the aperture. The
 * control a step lights is found by its registry target id, and a pointer at
 * its visible centre must reach it, not the card, the dim or anything else.
 *
 * A step whose control is missing degrades to text for a person; here it is a
 * failure, because a tutorial that points at nothing is the bug.
 *
 *   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
 *   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
 *     pnpm --filter @opensesame/pages verify:tutorials
 *
 * `TUTORIALS_DEV_URL=http://localhost:5180` walks a running dev server
 * instead of `dist/`; `TUTORIALS_ONLY=vault.lock,vault.export` narrows it.
 * `TUTORIALS_DIST` walks a profile build. `TUTORIALS_ENABLE=installed` leaves
 * the build's approvals alone; `except-ai` turns sections on and then drops
 * the on-device and remote support models (`TUTORIALS_AI=off` does that drop
 * on its own).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  enableEverything,
  ensureModelsOff,
} from "./lib/enable-capabilities.mjs";
import { passTheDoor } from "./lib/front-door.mjs";
import { sealLocalOnly } from "./lib/pages-journey.mjs";
import { inShard, isFirstShard, parseShard } from "./lib/shard.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { gatePass, popupPass } from "./lib/tutorial-gates.mjs";
import {
  escapeEndsTheTour,
  moveAdvancesTheTour,
} from "./lib/tutorial-interact.mjs";
import { seedVault } from "./lib/tutorial-seed.mjs";
import {
  listTutorials,
  resetToVault,
  unlockIfLocked,
} from "./lib/tutorial-walk.mjs";
import { createWalker } from "./lib/tutorial-walker.mjs";

const devUrl = process.env.TUTORIALS_DEV_URL ?? "";
const origin = devUrl || "https://tyler-r-kendrick.github.io";
const base = devUrl
  ? "/OpenSesame/"
  : (process.env.VITE_BASE ?? "/OpenSesame/");
const out = process.env.TUTORIALS_OUT ?? "/tmp/opensesame-tutorials";
fs.mkdirSync(out, { recursive: true });
const only = new Set(
  (process.env.TUTORIALS_ONLY ?? "").split(",").filter(Boolean),
);
const widths = (process.env.TUTORIALS_WIDTHS ?? "1280,390")
  .split(",")
  .map(Number);
const shard = parseShard(process.env.TUTORIALS_SHARD);
const firstShard = isFirstShard(shard);
const keepShots = process.env.TUTORIALS_SHOTS === "1";
const verbose = process.env.TUTORIALS_VERBOSE === "1";

const dist = process.env.TUTORIALS_DIST
  ? path.resolve(process.env.TUTORIALS_DIST)
  : fileURLToPath(new URL("../dist", import.meta.url));
const harness = createHarness({
  dist,
  origin,
  base,
  out,
});
const failures = [];
const passes = [];
const timings = [];
const walkStarted = Date.now();
let where = "boot";
function check(ok, what) {
  if (ok) passes.push(what);
  else {
    failures.push(`[${where}] ${what}`);
    console.log(`  FAIL [${where}] ${what}`);
  }
}

const walker = createWalker({
  check,
  setWhere: (next) => {
    where = next;
  },
  base,
  out,
  keepShots,
});
const { walkOne, guarded } = walker;

const browser = devUrl
  ? await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
      headless: true,
    })
  : await harness.launch();

const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
};

async function newPage(width) {
  const device = width < 600 ? PHONE : { viewport: { width, height: 900 } };
  if (!devUrl) {
    const made = await harness.newPage(browser, { device });
    return made;
  }
  const context = await browser.newContext(device);
  const page = await context.newPage();
  page.on("pageerror", (error) =>
    harness.record("PAGE-ERROR", String(error.message).slice(0, 300)),
  );
  return { page, context };
}

const say = (line) => {
  if (verbose) console.log(line);
};

async function sealedShell(width) {
  const made = await newPage(width);
  const { page } = made;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame())
      say(`  · navigated ${frame.url().replace(origin, "")}`);
  });
  say("  opening the door");
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  // The app root is a lazy chunk: on a slow runner the network goes idle before
  // the door is drawn, and passTheDoor looks once. Wait for either screen.
  await page
    .getByRole("button", { name: "Set up your own" })
    .or(page.getByRole("heading", { level: 1, name: "Sign in" }))
    .first()
    .waitFor({ timeout: 30000 });
  await passTheDoor(page);
  say("  sealing a vault");
  await sealLocalOnly(page);
  // `installed` walks only what this build already approved. `except-ai`
  // turns every other section on, then drops the two support models.
  const enable = process.env.TUTORIALS_ENABLE ?? "all";
  const modelsOff =
    process.env.TUTORIALS_AI === "off" || enable === "except-ai";
  if (enable !== "installed") {
    say("  switching every capability on");
    await enableEverything(page, { origin, base, verbose });
  }
  if (modelsOff) {
    say("  leaving support models off");
    await ensureModelsOff(page, { origin, base, verbose });
  }
  say("  back to the vault");
  await page.goto(`${origin}${base}vault`, { waitUntil: "domcontentloaded" });
  await unlockIfLocked(page);
  await resetToVault(page, base);
  return made;
}

const wants = (id) => only.size === 0 || only.has(id);
// The gates and the passes that are not a tutorial belong to the first shard.
const gatesWanted =
  firstShard &&
  (only.size === 0 || [...only].some((id) => id.startsWith("gate.")));

/** One tutorial a gate offers, walked on the gate it was listed from. */
async function walkGate(page, entry, { phone, width }) {
  const began = Date.now();
  try {
    await walkOne(page, entry, { phone, width, reset: false });
  } catch (error) {
    check(
      false,
      `${entry.id}: walking threw — ${String(error.message).split("\n")[0]}`,
    );
    await page
      .screenshot({ path: `${out}/${width}-${entry.id}-error.png` })
      .catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }
  timings.push({ id: `${width}px ${entry.id}`, ms: Date.now() - began });
}

const helpers = { say, wants, walkGate, guarded };

async function shellPass(width) {
  const phone = width < 600;
  where = `${width}px shell`;
  const { page, context } = await sealedShell(width);
  const listed = await listTutorials(page);
  check(
    !listed.some((entry) => entry.id.startsWith("gate.")),
    "the shell's library offers none of the gates' tutorials (ADR 0166)",
  );
  const entries = listed.filter(
    (entry) =>
      (only.size === 0 || only.has(entry.id)) && inShard(entry.id, shard),
  );
  console.log(`${width}px: ${entries.length} tutorials on the shell`);
  const started = Date.now();
  if (firstShard && (only.size === 0 || only.has("vault.lock"))) {
    where = `${width}px escape`;
    await guarded(page, "escape", () =>
      escapeEndsTheTour(page, { check, base }),
    );
  }
  if (firstShard && (only.size === 0 || only.has("vaults.switch"))) {
    where = `${width}px move`;
    await guarded(page, "move", () =>
      moveAdvancesTheTour(page, { check, base }),
    );
  }
  await walkEntries(page, entries, { phone, width });
  // A tutorial that points at an item is offered only where the vault holds
  // one, so a second pass adds items the way a person does and walks what the
  // library offers then that it did not before.
  const walked = new Set(entries.map((entry) => entry.id));
  where = `${width}px seed`;
  await guarded(page, "seed", () => seedVault(page, base));
  const later = (await listTutorials(page)).filter(
    (entry) =>
      !walked.has(entry.id) &&
      (only.size === 0 || only.has(entry.id)) &&
      inShard(entry.id, shard),
  );
  console.log(`${width}px: ${later.length} more once the vault holds items`);
  await walkEntries(page, later, { phone, width });
  const seconds = Math.round((Date.now() - started) / 1000);
  const total = entries.length + later.length;
  check(total > 0, "the library offers tutorials");
  console.log(`${width}px: ${total} tutorials walked in ${seconds}s`);
  if (gatesWanted) {
    const popupsBegan = Date.now();
    await guarded(page, "popups", () =>
      popupPass({
        width,
        phone,
        context,
        origin,
        base,
        check,
        setWhere: (next) => {
          where = next;
        },
        helpers,
      }),
    );
    console.log(
      `${width}px: popups walked in ${Math.round((Date.now() - popupsBegan) / 1000)}s`,
    );
  }
  await context.close();
}

async function walkEntries(page, entries, { phone, width }) {
  for (const entry of entries) {
    const began = Date.now();
    try {
      await walkOne(page, entry, { phone, width });
    } catch (error) {
      check(
        false,
        `${entry.id}: walking threw — ${String(error.message).split("\n")[0]}`,
      );
      await page
        .screenshot({ path: `${out}/${width}-${entry.id}-error.png` })
        .catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
    }
    timings.push({ id: `${width}px ${entry.id}`, ms: Date.now() - began });
    if (failures.length > 0 && process.env.TUTORIALS_BAIL === "1") break;
  }
}

async function gateScreens(width) {
  const began = Date.now();
  const phone = width < 600;
  where = `${width}px gates`;
  try {
    await gatePass({
      width,
      phone,
      newPage,
      origin,
      base,
      check,
      setWhere: (next) => {
        where = next;
      },
      walker,
      helpers,
    });
  } catch (error) {
    check(
      false,
      `gates: walking threw — ${String(error.message).split("\n")[0]}`,
    );
  }
  console.log(
    `${width}px: gates walked in ${Math.round((Date.now() - began) / 1000)}s`,
  );
}

try {
  for (const width of widths) {
    await shellPass(width);
    if (gatesWanted) await gateScreens(width);
  }
} finally {
  await browser.close();
}

const slowest = timings.sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log(
  `wall time ${Math.round((Date.now() - walkStarted) / 1000)}s; slowest: ${slowest
    .map((entry) => `${entry.id} ${Math.round(entry.ms / 1000)}s`)
    .join(", ")}`,
);
const pageErrors = harness.log.filter((entry) => entry.kind === "PAGE-ERROR");
for (const entry of pageErrors)
  failures.push(`[${entry.step}] page error: ${entry.detail}`);
console.log(`\n${passes.length} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
  fs.writeFileSync(`${out}/failures.txt`, failures.join("\n"));
  console.log(failures.slice(0, 80).join("\n"));
  process.exit(1);
}
