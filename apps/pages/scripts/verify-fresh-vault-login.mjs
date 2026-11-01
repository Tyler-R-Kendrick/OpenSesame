#!/usr/bin/env node
/**
 * P8-4: a fresh guest vault turns on Passwords in one step and saves a login.
 *
 * The walker builds `dist/` with the onboarding flag unless VERIFY_SKIP_BUILD=1.
 * To reuse a manual flag build:
 *
 *   VITE_BASE=/OpenSesame/ VITE_PWA_OFFER_PASSWORDS_ONBOARDING=1 \
 *     pnpm --filter @opensesame/pages build
 *   VERIFY_SKIP_BUILD=1 pnpm --filter @opensesame/pages verify:fresh-vault-login
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseType } from "./lib/editor-type.mjs";
import { doorGuest } from "./lib/front-door.mjs";
import { waitOpen } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const DIST = path.resolve(here, "../dist");
const ORIGIN = "https://opensesame-labs.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(ROOT, "artifacts/fresh-vault-login");
const NAME = "Fresh vault login";
const USERNAME = "fresh.person@example.com";
const PASSWORD = "fresh-vault-password-2026";

if (process.env.VERIFY_SKIP_BUILD !== "1") {
  const built = spawnSync("node", ["scripts/lib/ci-pages-build.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_BASE: BASE,
      VITE_PWA_OFFER_PASSWORDS_ONBOARDING: "1",
    },
  });
  if (built.error) throw built.error;
  if (built.status !== 0) process.exit(built.status ?? 1);
}

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`no build at ${DIST} — run the Pages build first`);
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
try {
  const guest = await newPage(browser);
  const { page } = guest;
  setStep("fresh-guest");
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await doorGuest(page).click();
  await waitOpen(page);

  setStep("offer-passwords");
  await page.getByText("nothing sealed yet").waitFor({ timeout: 20_000 });
  const bufferOffer = await page
    .locator(".buffer")
    .getByRole("button", { name: "Passwords", exact: true })
    .count();
  check(bufferOffer === 0, "the empty buffer has no Passwords control");
  const offer = page
    .getByRole("group", { name: "Vault commands" })
    .getByRole("button", { name: "Passwords", exact: true });
  await offer.waitFor({ state: "visible", timeout: 20_000 });
  check(true, "the fresh empty vault offers Passwords on the path strip");
  await snap(page, "passwords-offer");
  await offer.click();
  await offer.waitFor({ state: "hidden", timeout: 30_000 });
  check(true, "the one-step offer commits and leaves the path strip");

  setStep("create-login");
  await page
    .getByRole("link", { name: "New item", exact: true })
    .first()
    .click();
  await page.getByLabel("Name", { exact: true }).waitFor({ timeout: 20_000 });
  await chooseType(page, "account");
  await page.getByLabel("Name", { exact: true }).fill(NAME);
  await page.getByLabel("Username / ID", { exact: true }).fill(USERNAME);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page
    .getByRole("heading", { level: 1, name: NAME, exact: true })
    .waitFor({ timeout: 20_000 });

  setStep("login-listed");
  const row = page.locator(".vtree__row", { hasText: NAME }).first();
  await row.waitFor({ state: "visible", timeout: 20_000 });
  check((await row.innerText()).includes(NAME), "the saved login is listed");
  await snap(page, "login-listed");
  await guest.context.close();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  for (const [index, context] of browser.contexts().entries()) {
    for (const [pageIndex, page] of context.pages().entries()) {
      await page
        .screenshot({
          path: path.join(OUT, `failed-${index + 1}-${pageIndex + 1}.png`),
        })
        .catch(() => {});
    }
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
for (const entry of log) {
  if (entry.kind === "PASS" || entry.kind === "FAIL") {
    console.log(`${entry.kind} [${entry.step}] ${entry.detail}`);
  }
}
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
if (failures.length > 0 || hard.length > 0) {
  console.error(
    `${failures.length} failed checks, ${hard.length} hard errors — see ${OUT}`,
  );
  process.exit(1);
}
console.log(`fresh-vault-login ok — artifacts in ${OUT}`);
