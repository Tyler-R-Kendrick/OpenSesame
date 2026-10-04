#!/usr/bin/env node
/**
 * Every tutorial, walked end to end in a real browser (ADR 0161).
 *
 * The Support sheet's Tutorials tab is the only way in: this suite lists what
 * the product offers, starts each one from its row, and gets through it with
 * Next alone — by mouse on one step and by keyboard on the next — checking on
 * every step that the card is whole and inside the screen, that Next is
 * there, that the steps are numbered 1..N with none skipped, and that the
 * control being pointed at is lit, visible, uncovered and reachable through
 * the aperture. Then it goes Back, Replays, finishes with
 * Done and checks where focus went. It does this at desktop and phone width,
 * on the shell with every optional capability switched on. The gates (front
 * door, unlock, setup) carry no Support mark by design (ADR 0090), and no
 * tutorial is offered there: every tutorial is one a Support mark can start.
 * It also leaves a tour with Escape from the card and from the lit control,
 * and makes the move an action step waits for through the aperture. The
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
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { enableEverything } from "./lib/enable-capabilities.mjs";
import { passTheDoor } from "./lib/front-door.mjs";
import { sealLocalOnly } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import {
  escapeEndsTheTour,
  moveAdvancesTheTour,
} from "./lib/tutorial-interact.mjs";
import {
  advancedFrom,
  listTutorials,
  reachedStep,
  readStep,
  resetToVault,
  startTutorial,
  tutorialDialog,
  unlockIfLocked,
  walkSteps,
} from "./lib/tutorial-walk.mjs";

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
const keepShots = process.env.TUTORIALS_SHOTS === "1";
const verbose = process.env.TUTORIALS_VERBOSE === "1";

const harness = createHarness({
  dist: fileURLToPath(new URL("../dist", import.meta.url)),
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
  await passTheDoor(page);
  say("  sealing a vault");
  await sealLocalOnly(page);
  say("  switching every capability on");
  await enableEverything(page, { origin, base, verbose });
  say("  back to the vault");
  await page.goto(`${origin}${base}vault`, { waitUntil: "domcontentloaded" });
  await unlockIfLocked(page);
  await resetToVault(page, base);
  return made;
}

async function finishTour(page, id, phone, total, shot) {
  // Back goes back, and Replay begins again.
  const replay = page.getByRole("button", { name: "Replay" });
  await replay.click();
  const first = await readStep(page);
  check(
    Boolean(first) && first.step === 1 && first.kind !== "close",
    `${id}: Replay returns to the first step`,
  );
  const again = await walkSteps(page, {
    id: `${id} (replay)`,
    check,
    phone,
    total,
    press: "keyboard",
  });
  check(
    again.at(-1)?.kind === "close",
    `${id}: the replay reaches the closing card again`,
  );
  if (shot) await page.screenshot({ path: `${out}/${shot}-close.png` });
  await page.getByRole("button", { name: "Done" }).click();
  await tutorialDialog(page)
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => {});
  check(
    (await tutorialDialog(page).count()) === 0,
    `${id}: Done closes the tutorial`,
  );
  const focus = await page.evaluate(
    () => document.activeElement?.tagName ?? "none",
  );
  check(
    focus !== "BODY" && focus !== "none",
    `${id}: focus is handed back, not dropped on the page (${focus})`,
  );
}

/** Forward one step, then Back, so the first step is walked again from its start. */
async function backAndForth(page, id, first) {
  if (first.kind === "close") return;
  await page.locator(".coach__btn--go").click();
  check(await advancedFrom(page, first), `${id}: Next leaves the first step`);
  const second = await readStep(page);
  if (!second) return;
  if (second.kind === "close") {
    // A one-step tutorial goes straight to its close, which offers Replay
    // where a step offers Back: begin again, so the step itself is walked.
    await page.getByRole("button", { name: "Replay" }).click();
    check(
      await reachedStep(page, first.step),
      `${id}: Replay leaves the closing card`,
    );
    const again = await readStep(page);
    check(
      again?.step === first.step,
      `${id}: Replay returns to the first step`,
    );
    return;
  }
  check(
    second.step === first.step + 1,
    `${id}: Next advances exactly one step`,
  );
  check(
    second.backDisabled === false,
    `${id}: Back is available after the first step`,
  );
  await page.getByRole("button", { name: "Back" }).click();
  check(
    await reachedStep(page, first.step),
    `${id}: Back leaves the second step`,
  );
  const back = await readStep(page);
  check(back?.step === first.step, `${id}: Back returns to the previous step`);
}

async function walkOne(page, entry, { phone, width, reset = true }) {
  const id = entry.id;
  where = `${width}px ${id}`;
  if (reset) {
    await resetToVault(page, base);
    await unlockIfLocked(page);
  }
  const card = await startTutorial(page, id);
  check((await card.count()) === 1, `${id}: the tutorial opens its card`);
  const first = await readStep(page);
  check(Boolean(first), `${id}: the first step is drawn`);
  if (!first) return;
  check(
    first.focusInCard,
    `${id}: focus lands on the card when a tutorial starts`,
  );
  if (first.counter) {
    const total = Number(first.counter.split(" of ")[1]);
    check(
      Number.isFinite(total) && total === entry.steps,
      `${id}: the library said ${entry.steps} steps and the tutorial has ${total}`,
    );
  }
  await backAndForth(page, id, first);
  const shots = keepShots
    ? async (info, index) =>
        page.screenshot({
          path: `${out}/${width}-${id.replace(/[^a-z0-9]+/gi, "_")}-${index}.png`,
        })
    : null;
  const seen = await walkSteps(page, {
    id,
    check,
    phone,
    total: entry.steps,
    snap: shots,
  });
  check(
    seen.at(-1)?.kind === "close",
    `${id}: reaches its closing card with Next alone`,
  );
  if (seen.at(-1)?.kind === "close")
    await finishTour(
      page,
      id,
      phone,
      entry.steps,
      keepShots ? `${width}-${id}` : null,
    );
  else await page.keyboard.press("Escape");
}

/** One interaction check; a throw is a failure with its cause, never a skip. */
async function guarded(page, what, run) {
  try {
    await run();
  } catch (error) {
    check(false, `${what}: threw — ${String(error.message).split("\n")[0]}`);
    await page.keyboard.press("Escape").catch(() => {});
  }
}

async function shellPass(width) {
  const phone = width < 600;
  where = `${width}px shell`;
  const { page, context } = await sealedShell(width);
  const entries = (await listTutorials(page)).filter(
    (entry) => only.size === 0 || only.has(entry.id),
  );
  console.log(`${width}px: ${entries.length} tutorials on the shell`);
  check(entries.length > 0, "the library offers tutorials");
  const started = Date.now();
  if (only.size === 0 || only.has("vault.lock")) {
    where = `${width}px escape`;
    await guarded(page, "escape", () =>
      escapeEndsTheTour(page, { check, base }),
    );
  }
  if (only.size === 0 || only.has("vaults.switch")) {
    where = `${width}px move`;
    await guarded(page, "move", () =>
      moveAdvancesTheTour(page, { check, base }),
    );
  }
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
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`${width}px: ${entries.length} tutorials walked in ${seconds}s`);
  await context.close();
}

try {
  for (const width of widths) {
    await shellPass(width);
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
