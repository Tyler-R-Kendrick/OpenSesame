// Prove the built Pages bundle works as a static front end with NO backend,
// under the real production origin (ADR 0090).
//   pnpm --filter @opensesame/pages build   (VITE_BASE=/OpenSesame/)
//   node apps/pages/scripts/verify-static-origin.mjs
// Every request to the production origin is served from `dist/` (unknown
// paths fall back to index.html with a 404 status, exactly as GitHub Pages
// does); every other origin is refused — except a mocked shoo.dev for the
// Google return leg. The run fails on any page error, any console error
// other than the SPA-fallback 404, any request to a loopback address, any
// missing asset, or any failed check below.
//   A. first screen: the front door — the two roads, the compiled broker +
//      guest, no setup wall (ADR 0115)
//   B. guest → inside the app → every section, and every subtree within Access,
//      by in-app navigation
//   C. Google via Shoo: the authorize request, then the return leg against a
//      mocked /token + /session/check, landing unlocked with the person named
//   D. deep link: the icon resolves under the base, not under the route
// After B and C, nothing the app stored may rest in the clear (ADR 0149).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAccountWebsites } from "./lib/account-websites-contract.mjs";
import { checkNothingInTheClear } from "./lib/at-rest-contract.mjs";
import {
  addCapability,
  checkGatedSectionsAbsent,
} from "./lib/capability-walk-contract.mjs";
import { checkEditorPaths } from "./lib/editor-path-contract.mjs";
import { checkEditorRoutes } from "./lib/editor-routes-contract.mjs";
import { checkEditorTabOrder } from "./lib/editor-tab-order-contract.mjs";
import {
  checkFrontDoor,
  walkSetupCeremony,
} from "./lib/front-door-contract.mjs";
import { doorGuest, passTheDoor } from "./lib/front-door.mjs";
import { tabToAccessControl } from "./lib/local-access-journey.mjs";
import { openIdentityView } from "./lib/local-directory-navigation.mjs";
import { openSection, sealLocalOnly } from "./lib/pages-journey.mjs";
import { checkStaticAccess } from "./lib/static-access-contract.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { checkStatusline } from "./lib/statusline-contract.mjs";
import { walkUnlockHero } from "./lib/unlock-hero-contract.mjs";
import { checkVaultPane } from "./lib/vault-pane-contract.mjs";
import { checkWordmark } from "./lib/wordmark-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.PAGES_VERIFY_DIST ?? path.resolve(here, "..", "dist");
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "..", "..", "..", "artifacts", "static-origin"),
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

const browser = await launch();
// ---- A + B: first screen, then guest through every section
{
  const { page, context } = await newPage(browser);
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  // Network idle does not include asynchronous local-store initialization.
  // Wait for the front door to render before capturing its first-screen contract.
  await page
    .getByRole("button", { name: "Set up your own", exact: true })
    .waitFor({ state: "visible", timeout: 15_000 });
  const text = await snap(page, "A-first-screen");
  await checkFrontDoor(page, check, text, BASE);
  await checkWordmark(page, check);
  await walkSetupCeremony(page, check, snap);

  // Skip all retires the door onto sign-in, whose one no-account road is
  // the local seal. The full-size guest button is not on that screen.
  await sealLocalOnly(page);
  const inApp = await snap(page, "B-sealed-in-app");
  // Lock is an icon key (accessible name). Then lock-v5 hero geometry + ink.
  check(
    (await page.getByRole("button", { name: "Lock vault" }).count()) > 0,
    "the local seal landed inside the app",
  );
  check(!/Claim this guest session/.test(inApp), "no claim notice");
  setStep("B-unlock-hero");
  await walkUnlockHero(page, check);
  setStep("B-at-rest");
  await checkNothingInTheClear(page, check, ["guest-\\d+"]);
  // Capabilities: absence first, then add what the surface contracts need (ADR 0130).
  setStep("E-gated");
  await checkGatedSectionsAbsent(page, check);
  for (const [title, rail] of [
    // Always on: checked present, never offered a switch.
    ["Guided help", null],
    // Optional extensions: absent until the switch, then present (ADR 0153).
    ["External connectors", "connections/"],
    ["Access authority", "access/"],
    ["Browser-local IAM", "identity/"],
    ["Derived item types", null],
    ["Passkey records", null],
    ["Wallet", "wallet/"],
  ]) {
    setStep(`E-add-${(rail ?? title).replace("/", "")}`);
    await addCapability(page, check, snap, title, rail);
  }

  // Back where the walk landed: the adds above finish on Settings, and the
  // contracts below measure the vault pane.
  setStep("B-back-to-vault");
  await page.locator(".railtree__row", { hasText: "vault/" }).first().click();
  await page.waitForTimeout(1200);

  await checkStatusline(page, check);
  await checkVaultPane(page, check);
  await checkEditorTabOrder(page, check);
  await checkEditorRoutes(page, check);
  await checkEditorPaths(page, check);
  await checkAccountWebsites(page, check);

  for (const [label, name] of [
    ["connections/", "B-connections"],
    ["access/", "B-access"],
    ["identity/", "B-identity"],
    ["settings/", "B-settings"],
  ]) {
    setStep(name);
    await openSection(page, label);
    await page.waitForTimeout(1200);
    const sectionText = await snap(page, name);
    check(
      !/Something went wrong|Uncaught/i.test(sectionText),
      `${name} rendered`,
    );
    check(
      (await page.locator('[role="alert"]').count()) === 0,
      `${name} shows no alert`,
    );

    if (name === "B-access")
      await checkStaticAccess(page, check, snap, setStep);
  }
  for (const category of [
    "general",
    "security",
    "data",
    "vaults",
    "connectivity",
    "danger",
  ]) {
    setStep(`B-settings-${category}`);
    const tab = page
      .getByRole("link", { name: new RegExp(`^${category}`, "i") })
      .first();
    if (await tab.count()) {
      await tab.click();
      await page.waitForTimeout(900);
      await snap(page, `B-settings-${category}`);
      check(
        (await page.locator('[role="alert"]').count()) === 0,
        `settings/${category} shows no alert`,
      );
    }
  }
  await context.close();
}

// ---- C: Google via Shoo, there and back
{
  const { page, context, shooCalls } = await newPage(browser, { shoo: true });
  setStep("C-google");
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  // Sign-in is behind the door's setup road (ADR 0150 §1).
  await passTheDoor(page);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.waitForTimeout(2000);
  const authorize = new URL(page.url());
  check(
    authorize.origin === "https://shoo.dev" &&
      authorize.pathname === "/authorize",
    "navigated to shoo authorize",
  );
  check(
    authorize.searchParams.get("client_id") === `origin:${ORIGIN}`,
    "client_id is the origin profile",
  );
  check(
    authorize.searchParams.get("redirect_uri") === `${ORIGIN}${BASE}`,
    "redirect_uri is the app base",
  );
  check(
    authorize.searchParams.get("code_challenge_method") === "S256",
    "PKCE S256",
  );
  check(
    !authorize.searchParams.has("response_type") &&
      !authorize.searchParams.has("scope"),
    "shoo dialect",
  );
  const state = authorize.searchParams.get("state") ?? "";

  await page.goto(
    `${ORIGIN}${BASE}?code=verify-code&state=${encodeURIComponent(state)}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForTimeout(3500);
  const landed = await snap(page, "C-after-return");
  const token = shooCalls.find(
    (call) => call.path === "/token" && call.method === "POST",
  );
  check(Boolean(token), "POST /token exchanged the code");
  check(
    Boolean(
      token?.body?.includes("code_verifier=") &&
        token?.body?.includes("client_id=origin"),
    ),
    "token request carries verifier + origin client id",
  );
  check(
    shooCalls.some(
      (call) => call.path === "/session/check" && call.method === "POST",
    ),
    "POST /session/check validated the user",
  );
  check(!/Sign-in didn.t finish/.test(landed), "no failure card");
  check(
    /@/.test(landed) && !/^Sign in$/m.test(landed),
    "landed inside the app",
  );
  check(
    !/Finish attaching|Claim this guest|Identity is reachable/.test(landed),
    "no pending-link noise",
  );
  check(/test person/i.test(landed), "prompt names the signed-in person");
  setStep("C-at-rest");
  // The federation session is saved on the device, and sealed.
  const federation = "local:opensesame:federation:session";
  const leaks = ["pw_verify", "[Tt]est [Pp]erson"];
  await checkNothingInTheClear(page, check, leaks, [federation]);
  // This is a fresh device: Identity is off until chosen (ADR 0153). Add the
  // browser-local IAM section and the provider directory, then walk them.
  setStep("C-add-identity");
  await addCapability(page, check, snap, "Browser-local IAM", "identity/");
  await addCapability(page, check, snap, "Operator identity providers");
  setStep("C-provider-registration");
  await openSection(page, "identity/");
  await openIdentityView(page, tabToAccessControl, "Providers");
  await page
    .getByRole("button", { name: "Register an IdP", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Continue with Shoo", exact: true })
    .click();
  await page.waitForURL("https://shoo.dev/authorize?**");
  const registered = new URL(page.url());
  check(
    registered.searchParams.get("code_challenge_method") === "S256",
    "provider registration starts browser-direct PKCE without an Identity backend",
  );
  await context.close();
}

// ---- D: deep link asset resolution
{
  const deepLink = `${ORIGIN}${BASE}vault/health`;
  const { page, context } = await newPage(browser, {
    expectedFallbackUrl: deepLink,
  });
  setStep("D-deeplink");
  const response = await page.goto(deepLink, { waitUntil: "networkidle" });
  check(
    response?.status() === 404,
    "deep link uses the expected SPA fallback document",
  );
  await doorGuest(page).waitFor();
  check(
    (await page
      .getByRole("heading", { level: 1, name: "open-sesame", exact: true })
      .count()) === 1,
    "deep link renders the front door",
  );
  check(
    (await doorGuest(page).count()) === 1,
    "deep link retains guest access",
  );
  await page.waitForTimeout(800);
  const missing = log.filter(
    (entry) => entry.kind === "MISSING-ASSET" && entry.step === "D-deeplink",
  );
  check(
    missing.length === 0,
    `no missing asset on a deep link ${missing.map((m) => m.detail).join(", ")}`,
  );
  await context.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));

const loopback = log.filter((entry) => entry.kind === "LOOPBACK-REQUEST");
const pageErrors = log.filter((entry) => entry.kind === "PAGE-ERROR");
const consoleErrors = log.filter((entry) => entry.kind === "console-error");
const httpErrors = log.filter((entry) => entry.kind === "HTTP-ERROR");
const onScreen = log.filter(
  (entry) =>
    entry.kind === "ON-SCREEN" && !/^Not connected$/.test(entry.detail),
);
const missingAssets = log.filter((entry) => entry.kind === "MISSING-ASSET");
for (const entry of log)
  if (entry.kind === "PASS" || entry.kind === "FAIL")
    console.log(`${entry.kind} [${entry.step}] ${entry.detail}`);
console.log(`loopback requests: ${loopback.length}`);
console.log(
  "unexpected HTTP errors:",
  httpErrors.map((entry) => entry.detail),
);
console.log(
  `page errors: ${pageErrors.length}`,
  pageErrors.map((e) => `[${e.step}] ${e.detail.slice(0, 200)}`),
);
console.log(
  `console errors: ${consoleErrors.length}`,
  consoleErrors.map((e) => `[${e.step}] ${e.detail.slice(0, 200)}`),
);
console.log(
  "on-screen backend/localhost mentions:",
  onScreen.map((e) => `[${e.step}] ${e.detail}`),
);
console.log(
  "missing assets:",
  missingAssets.map((e) => `[${e.step}] ${e.detail}`),
);
const hard =
  loopback.length +
  httpErrors.length +
  pageErrors.length +
  consoleErrors.length +
  onScreen.length +
  missingAssets.length;
if (failures.length || hard) {
  console.log(
    `\n${failures.length} failed checks, ${hard} hard errors — see ${OUT}`,
  );
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED — artifacts in ${OUT}`);
