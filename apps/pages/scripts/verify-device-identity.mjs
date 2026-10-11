// Prove the device is the Identity plane on a static build with NO Identity API
// (ADR 0160), under the real production origin, at desktop and phone widths.
//
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   pnpm --filter @opensesame/pages verify:device-identity
//
// Same harness as `verify:static`: every request to the origin is served from
// `dist/`, every other origin is refused, and the run fails on any page error,
// console error, failed request, loopback request, or on-screen copy that
// names a service that is not there ("No Identity API", "localhost", "could
// not be", ...). Per width, a guest:
//
//   A. Settings › General draws no "sign out of Identity" row: the device has
//      no session yet, so there is nothing to sign out of (ADR 0158).
//   B. The connectivity status reads "This device", before and after Connect.
//   C. Connect from the Identity sheet ("Use this device") opens a device
//      session whose principal is `prn_` + a 43-character thumbprint, and
//      Refresh keeps the same principal: it is the vault's key, not a dice
//      roll.
//   D. Settings › General now draws the row.
//   E. Every Settings section reads clean (the forbidden-copy gate).
//   G. A member vault (password-sealed): the bound principal is the vault key's
//      thumbprint; locked, every device route answers 423; unlocked again it is
//      the same principal; a guest beside it is another principal and the
//      member's bearer does not speak for it.
//   H. A capability that activates after Access Sessions drew (its chunk is
//      held back) shows Receipts without a navigation.
//   I. The principal across backup and restore (ADR 0160 §5a), each device its
//      own browser context: export an offline backup and restore it on a fresh
//      device, taking its identity on the card, and the principal is the same;
//      a device whose fresh vault had already minted a key takes the backup's,
//      its old sessions end and the bell says so; a backup with no key mints
//      one key, once, and says so, and that key travels with the next backup.
//   J. A restore that does not take the backup's identity (the card's choice
//      is offered, and off) keeps the vault's principal and says nothing.
//   K. A guest session's restore card draws no choice about the identity at
//      all (a guest carries no key), and the backup restores and says nothing.
//   F. Access, once chosen: every tab reads clean, and Receipts is drawn only
//      once Browser-local IAM is on, because only it keeps an audit trail for
//      the device plane to serve.
//
// The Identity sheet is reached from the top bar, which a desktop does not
// draw; the desktop walk narrows the window to Connect and widens it again,
// with no reload, so the guest vault stays open.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureRestore,
  restoreAsGuest,
  restoreDeclined,
  restoredElsewhere,
  restoredWithoutKey,
} from "./lib/device-identity-restore.mjs";
import {
  WIDTHS,
  chooseCapability,
  clearCapability,
  configureScenarios,
  connect,
  go,
  lateActivation,
  memberVault,
  openGeneral,
  signOutRowCount,
  walkAccess,
} from "./lib/device-identity-scenarios.mjs";
import { doorGuest } from "./lib/front-door.mjs";
import { waitOpen } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(
  process.env.PAGES_VERIFY_DIST ?? path.join(here, "..", "dist"),
);
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "..", "..", "..", "artifacts", "device-identity"),
);

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`no build at ${DIST} — run the pages build first`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const { log, failures, check, setStep, launch, newPage, snap } = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});

configureScenarios({ ORIGIN, BASE, DIST, check, setStep, newPage, snap });
configureRestore({ ORIGIN, BASE, check, setStep, newPage });

const browser = await launch();
for (const width of WIDTHS) {
  const label = width.name;
  const { page, context } = await newPage(browser, { device: width.device });
  await page.setViewportSize(width.size);
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  setStep(`${label}-guest`);
  await doorGuest(page).click();
  await waitOpen(page);

  // A + B
  await openGeneral(page);
  await snap(page, `${label}-general-before`);
  check(
    (await signOutRowCount(page)) === 0,
    `${label}: no sign-out row before the device has a session`,
  );

  // B + C
  setStep(`${label}-connect`);
  if (width.narrow) await page.setViewportSize(width.narrow);
  await connect(page, label);
  if (width.narrow) await page.setViewportSize(width.size);

  // D
  setStep(`${label}-general-after`);
  await openGeneral(page);
  await snap(page, `${label}-general-after`);
  check(
    (await signOutRowCount(page)) === 1,
    `${label}: the sign-out row is drawn once the device has a session`,
  );

  // E
  setStep(`${label}-settings`);
  const sections = await page
    .locator(".set__nav a")
    .evaluateAll((links) =>
      links.map((link) => link.getAttribute("href") ?? "").filter(Boolean),
    );
  check(sections.length > 1, `${label}: Settings lists its sections`);
  for (const href of sections) {
    const route = href.startsWith(BASE) ? href.slice(BASE.length - 1) : href;
    await go(page, route);
    const text = await snap(
      page,
      `${label}-settings-${route.replace(/[^a-z0-9]+/gi, "_")}`,
    );
    check(!/Something went wrong|Uncaught/i.test(text), `${label}: ${route}`);
  }

  // F
  setStep(`${label}-access`);
  await chooseCapability(page, "Access authority");
  await clearCapability(page, "Browser-local IAM");
  await walkAccess(page, `${label}-no-iam`, { receipts: false });
  await chooseCapability(page, "Browser-local IAM");
  await walkAccess(page, `${label}-iam`, { receipts: true });

  await context.close();
}
await memberVault(browser);
await restoredElsewhere(browser);
await restoredWithoutKey(browser);
await restoreDeclined(browser);
await restoreAsGuest(browser);
await lateActivation(browser);
await browser.close();

fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
for (const entry of log)
  if (entry.kind === "PASS" || entry.kind === "FAIL")
    console.log(`${entry.kind} [${entry.step}] ${entry.detail}`);

const hard = log.filter((entry) =>
  [
    "LOOPBACK-REQUEST",
    "HTTP-ERROR",
    "PAGE-ERROR",
    "console-error",
    "ON-SCREEN",
    "MISSING-ASSET",
  ].includes(entry.kind),
);
for (const entry of hard) {
  console.log(`${entry.kind} [${entry.step}] ${entry.detail.slice(0, 240)}`);
}
if (failures.length || hard.length) {
  console.log(
    `\n${failures.length} failed checks, ${hard.length} hard errors — see ${OUT}`,
  );
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED — artifacts in ${OUT}`);
