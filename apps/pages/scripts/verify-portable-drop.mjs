// Prove a portable drop opens on a second browser that never held the
// sender's vault (P8-1).
//
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   pnpm --filter @opensesame/pages verify:portable-drop
//
// Same harness as `verify:static`: every request to the origin is served from
// `dist/`, every other origin is refused, and the run fails on any page error,
// console error, failed request or loopback request.
//
//   A. A guest seals a secret. With no Identity API the drop is portable: the
//      card says any browser with the link, and the fragment carries the
//      bearer, the drop key and the sealed packet. The query string stays empty.
//   B. A second context, with its own storage, opens that link, enters the
//      user code on the drop ceremony, and reads the payload. The bearer has
//      already left the address.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doorGuest } from "./lib/front-door.mjs";
import { waitOpen } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(
  process.env.PAGES_VERIFY_DIST ?? path.join(here, "..", "dist"),
);
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://opensesame-labs.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "..", "..", "..", "artifacts", "portable-drop"),
);

const NAME = "Harbor note";
const PAYLOAD = "harbor-lantern-42";

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

async function go(page, route) {
  await page.evaluate(
    ([base, to]) => {
      history.pushState({}, "", base + to.replace(/^\//, ""));
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [BASE, route],
  );
  await page.waitForTimeout(900);
}

/** A new secret, through the editor a person uses. */
async function createSecret(page, name, value) {
  await go(page, "/vault/new");
  const nameField = page.getByLabel("Name", { exact: true });
  await nameField.waitFor({ timeout: 20_000 });
  await nameField.fill(name);
  await page.getByLabel("Secret value", { exact: true }).fill(value);
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page
    .getByRole("heading", { level: 1, name, exact: true })
    .waitFor({ timeout: 20_000 });
}

/** The drop card's field, with wrapping whitespace taken out of a link. */
async function rowValue(scope, label) {
  const row = scope.locator(".frow", { hasText: label }).first();
  return (await row.locator(".frow__value").first().innerText()).replace(
    /\s+/g,
    "",
  );
}

const browser = await launch();
setStep("sender-guest");
const sender = await newPage(browser);
await sender.page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
await doorGuest(sender.page).click();
await waitOpen(sender.page);

setStep("sender-seal");
await createSecret(sender.page, NAME, PAYLOAD);
await sender.page.getByRole("button", { name: "Share", exact: true }).click();
await sender.page
  .getByRole("menuitem", { name: "Temporary drop", exact: true })
  .click();
await sender.page
  .getByText("Any browser with the link", { exact: true })
  .waitFor({ timeout: 15_000 });
await sender.page.getByRole("button", { name: "Seal and share" }).click();
const ready = sender.page.getByRole("region", { name: "Drop ready" });
await ready.waitFor({ timeout: 30_000 });
await snap(sender.page, "sender-ready");

const link = await rowValue(ready, "Link");
const userCode = (await rowValue(ready, "User code")).trim();
const dropUrl = new URL(link);
const params = new URLSearchParams(dropUrl.hash.replace(/^#/, ""));
check(dropUrl.origin === ORIGIN, "the link names this origin");
check(dropUrl.search === "", "the bearer stays out of the query string");
check(
  (params.get("token") ?? "").startsWith("osc_pdrop_"),
  "the fragment carries a portable bearer",
);
check((params.get("key") ?? "") !== "", "the fragment carries the drop key");
check(
  (params.get("pkt") ?? "").startsWith("ospd1."),
  "the fragment carries the sealed packet",
);
check(/^[\dA-Z]{4}-[\dA-Z]{4}$/.test(userCode), "the card shows a user code");
check(
  (await ready.innerText()).includes("Any browser with the link"),
  "the card says any browser with the link can open it",
);

setStep("recipient-open");
const claimDocument = `${dropUrl.origin}${dropUrl.pathname}`;
const recipient = await newPage(browser, {
  expectedFallbackUrl: claimDocument,
});
// The claim path is the SPA fallback, so the document URL has no fragment.
// Boot reads the bearer from the address, so put the fragment back before
// any page script runs. A goto of the full link makes the 404 console name
// the fragment, which the fallback allowance cannot match.
await recipient.page.addInitScript((hash) => {
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}${hash}`,
  );
}, dropUrl.hash);
await recipient.page.goto(claimDocument, { waitUntil: "networkidle" });
await recipient.page
  .getByRole("heading", { level: 1, name: "Open a drop" })
  .waitFor({ timeout: 20_000 });
const openedAt = new URL(recipient.page.url());
check(openedAt.hash === "", "the bearer left the address before the ceremony");
check(
  !openedAt.search.includes("token") && !openedAt.search.includes("pkt"),
  "the ceremony address has no bearer in the query",
);
await recipient.page.getByLabel("One-time code").fill(userCode);
await recipient.page.getByRole("button", { name: "Open drop" }).click();
const opened = recipient.page.getByRole("region", { name: "Opened drop" });
await opened.waitFor({ timeout: 30_000 });
await snap(recipient.page, "recipient-opened");
check(
  (await opened.innerText()).includes(PAYLOAD),
  "the second browser shows the sealed payload",
);

await sender.context.close();
await recipient.context.close();
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
