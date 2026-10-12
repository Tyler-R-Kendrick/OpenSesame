/**
 * verify:trusted-contacts — Settings › Trusted contacts walked through the
 * real screens by five browsers (ADR 0187).
 *
 * `verify:quorum-browser` proves the desk over a real browser's WebAuthn and
 * PRF in blank pages. This proves the screens: an owner, three guardians and a
 * recipient, each in their own browser context at the production origin, each
 * with a virtual security key that does PRF, pressing the actual icon keys by
 * their accessible names and passing packets between pages by the clipboard —
 * a Copy key in one page, a paste into a field in the next. Every refusal is
 * read where a person reads it: a mark on the control that failed, the same
 * sentence in the tray, and nothing written in the page.
 *
 * The release delay is hours, so one clock is shared by every page
 * (`page.clock`) and moved forward for all of them at once, never by firing
 * timers.
 *
 * `WIDTH` (default 1280) sets the viewport, so the same walk runs at the
 * phone's width. `PAGES_DIST` names the build; `PAGES_VERIFY_OUT` the folder
 * the screenshots and page texts are written to.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { gather } from "./lib/tc-cast.mjs";
import { ownerCancels } from "./lib/tc-scenario-cancel.mjs";
import { guardianReplaced } from "./lib/tc-scenario-epoch.mjs";
import { happyRecovery, reloadSafety } from "./lib/tc-scenario-happy.mjs";
import { hostilePastes } from "./lib/tc-scenario-hostile.mjs";
import { keyRefusals } from "./lib/tc-scenario-keys.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const base = "/OpenSesame/";
const width = Number(process.env.WIDTH ?? 1280);
const out =
  process.env.PAGES_VERIFY_OUT ??
  `/tmp/opensesame-trusted-contacts-verification/${width}`;
fs.mkdirSync(out, { recursive: true });
for (const old of fs.readdirSync(out)) {
  if (old.startsWith("failed-")) fs.rmSync(`${out}/${old}`);
}
const harness = createHarness({
  dist:
    process.env.PAGES_DIST ??
    fileURLToPath(new URL("../dist", import.meta.url)),
  origin,
  base,
  out,
});

let count = 0;
const shot = () => String(++count).padStart(2, "0");
const started = Date.now();

/** One scenario: it either finishes, or the gate does. */
async function scenario(name, run) {
  const at = Date.now();
  harness.setStep(name);
  try {
    await run();
  } catch (error) {
    await cast?.photographFailure(
      name.replace(/[^a-z0-9]+/gi, "_").slice(0, 40),
    );
    throw error;
  }
  console.log(
    `PASS ${width}px: ${name} (${Math.round((Date.now() - at) / 1000)}s)`,
  );
}

const browser = await harness.launch();
let cast;
try {
  cast = await gather({ harness, browser, width, shot, out });
  const ctx = { cast, harness, width, out };
  const state = {};
  await scenario(
    "a 2-of-3 recovery, key by key, through the screens",
    async () => {
      Object.assign(state, await happyRecovery(ctx));
    },
  );
  await scenario("a reload before anything is saved loses nothing", () =>
    reloadSafety(ctx, state),
  );
  await scenario(
    "hostile pastes are refused on their field and in the tray",
    () => hostilePastes(ctx, state),
  );
  await scenario(
    "a key that will not do what it must is refused, and then works",
    () => keyRefusals(ctx, state),
  );
  await scenario(
    "the owner cancels a request and no contact can approve it",
    () => ownerCancels(ctx, state),
  );
  await scenario(
    "a guardian is replaced as a new epoch, and only the new file recovers",
    () => guardianReplaced(ctx, state),
  );
} finally {
  await cast?.close();
  await browser.close();
}

if (process.env.TC_VERBOSE) {
  const kinds = {};
  for (const entry of harness.log)
    kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  console.log(`log kinds: ${JSON.stringify(kinds)}`);
  for (const entry of harness.log.filter((e) => e.kind === "console-error"))
    console.log(`console-error [${entry.step}] ${entry.detail}`);
  for (const entry of harness.log.filter((e) => /REFUSAL/.test(e.kind)))
    console.log(`${entry.kind} [${entry.step}] ${entry.detail}`);
}
const bad = harness.log.filter((entry) =>
  [
    "PAGE-ERROR",
    "LOOPBACK-REQUEST",
    "HTTP-ERROR",
    "MISSING-ASSET",
    "ON-SCREEN",
  ].includes(entry.kind),
);
for (const entry of bad)
  console.error(`${entry.kind} [${entry.step}] ${entry.detail}`);
if (harness.failures.length > 0 || bad.length > 0) {
  throw new Error("Trusted contacts walk reported browser errors");
}
console.log(
  `PASS ${width}px: no page error, loopback request or failed request (${Math.round((Date.now() - started) / 1000)}s in all)`,
);
