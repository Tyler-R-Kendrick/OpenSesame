// Prove vault Share is PAM + secret drops, not "Accept a claim" (restore of
// the pre-#784 behaviour on this stack):
//
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   PLAYWRIGHT_CHROMIUM=$HOME/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
//     pnpm --filter @opensesame/pages verify:share-pam
//
// A guest on the static build (no Identity API, device-native claim plane),
// in ONE tab the whole way:
//
//   1. Switch Access authority on; add a person to the local directory.
//   2. Vault header Share key → the grant sheet (PAM: identity, policy,
//      duration), never /claim — grant the vault, screenshot.
//   3. A folder's context menu Share → Person or agent → the same sheet,
//      prefilled with the folder's synthetic target — grant, screenshot.
//   4. Access › Grants lists both grants; revoke them and the recipient
//      holds no standing access. Revoke runs BEFORE the drop below: a second
//      tab's front-door Skip would re-seal the guest tomb and hide this
//      ledger, so the walk never opens one.
//   5. An item's Share once → the drop ceremony; the sealed link is opened
//      by IN-APP navigation on the same tab (pushState + popstate, so the
//      vault session — per-tab, in memory — stays unlocked for the device
//      claim plane). The one-time code opens the drop; a second present of
//      the same link is refused by the plane itself.
//
// Screenshots land in /opt/cursor/artifacts/restore-share-pam (PAGES_VERIFY_OUT
// overrides). Fails on any page error, missing asset, loopback request, or
// forbidden copy, as every static-origin walk does.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doorGuest } from "./lib/front-door.mjs";
import {
  addCapabilities,
  openSection,
  waitOpen,
} from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ?? "/opt/cursor/artifacts/restore-share-pam",
);

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`no build at ${DIST} — run the pages build first`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const { failures, check, setStep, launch, newPage, snap } = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});

/** In-app navigation: the router's own history, so no reload ends the vault. */
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

const browser = await launch();
const { page } = await newPage(browser, {});

setStep("guest");
await page.goto(`${ORIGIN}${BASE}`, {
  waitUntil: "domcontentloaded",
  timeout: 15000,
});
await doorGuest(page).click();
await waitOpen(page);

// Access authority carries the grant ledger; Browser-local IAM the local
// directory, and Directory provisioning the People tab that edits it.
await addCapabilities(page, [
  "Browser-local IAM",
  "Directory provisioning",
  "Access authority",
]);

// A person to grant to, beside the seeded owner.
setStep("add-person");
await openSection(page, "Identity");
await page
  .getByRole("tab", { name: "People", exact: true })
  .first()
  .click()
  .catch(() => undefined);
const newPerson = page.getByRole("button", { name: "New person" });
await newPerson.waitFor({ timeout: 15000 });
await newPerson.click();
await page.locator("#local-identity-name").fill("Ada Lovelace");
await page.getByRole("button", { name: "Save changes" }).click();
await page.getByText("Ada Lovelace", { exact: true }).first().waitFor({
  timeout: 10000,
});
check(true, "local directory holds the person");

// A folder with a secret in it.
setStep("seed-vault");
await go(page, "/vault");
await page.getByRole("link", { name: "New item" }).first().click();
const nameField = page.getByLabel("Name", { exact: true });
await nameField.waitFor({ state: "visible", timeout: 15000 });
const type = page.getByLabel("Type", { exact: true });
if ((await type.count()) > 0 && (await type.isVisible().catch(() => false))) {
  await type.selectOption("secret");
}
await nameField.fill("./Work/Deploy key");
await nameField.press("Tab");
if (
  (await page.getByLabel("Name", { exact: true }).inputValue()) !== "Deploy key"
) {
  await nameField.fill("Deploy key");
}
await page.locator("#secret-value").fill("restore-share-pam-secret");
await page.getByRole("button", { name: "Save item" }).click();
await page
  .locator(".vtree__row", { hasText: "Deploy key" })
  .first()
  .waitFor({ timeout: 15000 });
check(true, "folder Work holds the secret Deploy key");

// 1. Vault header Share → the PAM grant sheet.
setStep("share-vault");
await go(page, "/vault");
const shareKey = page.getByRole("link", { name: "Share", exact: true });
await shareKey.waitFor({ timeout: 10000 });
check(true, "vault header draws the Share key");
await shareKey.click();
const sheet = page.getByRole("dialog", { name: "Share" });
await sheet.waitFor({ timeout: 10000 });
check(!page.url().includes("/claim"), "Share opens a sheet, never /claim");
await sheet.locator("#share-identity").selectOption({ label: "Ada Lovelace" });
await sheet.locator("#share-policy").selectOption("open");
await sheet.locator("#share-duration").selectOption("3600");
await snap(page, "01-share-vault-pam");
await sheet.getByRole("button", { name: "Grant", exact: true }).click();
await sheet.waitFor({ state: "detached", timeout: 10000 });
check(true, "vault grant written and the sheet closed");

// 2. Folder Share → Person or agent → same sheet, prefilled with the folder.
setStep("share-folder");
const folderRow = page.locator(".vtree__row", { hasText: "Work" }).first();
await folderRow.click({ button: "right" });
await page.getByRole("menuitem", { name: "Share", exact: true }).click();
await page
  .getByRole("menuitem", { name: "Person or agent", exact: true })
  .click();
const folderSheet = page.getByRole("dialog", { name: "Share" });
await folderSheet.waitFor({ timeout: 10000 });
const folderTarget = await folderSheet
  .locator("#share-resource")
  .evaluate((select) => select.options[select.selectedIndex]?.text ?? "");
check(/Folder · Work/.test(folderTarget), `folder prefill: ${folderTarget}`);
await folderSheet
  .locator("#share-identity")
  .selectOption({ label: "Ada Lovelace" });
await snap(page, "02-share-folder-pam");
await folderSheet.getByRole("button", { name: "Grant", exact: true }).click();
await folderSheet.waitFor({ state: "detached", timeout: 10000 });
check(true, "folder grant written");

// 3. Access › Grants lists the walk's two standing grants beside the seeded
// default shares, and revoking both leaves the recipient with none. The
// ledger reads through OPFS; wait for its rows, not just the panel.
setStep("grants");
await go(page, "/access?view=grants");
await page.locator("#identity-shares").waitFor({ timeout: 15000 });
const firstRow = page.locator("#identity-shares li.identity-row").first();
const listed = await firstRow
  .waitFor({ timeout: 15000 })
  .then(() => true)
  .catch(() => false);
check(listed, "identity shares listed");
await snap(page, "03-grants-before-revoke");
const adaRows = page.locator("#identity-shares li.identity-row", {
  hasText: "Ada Lovelace",
});
check(
  (await adaRows.count()) === 2,
  "the walk's two standing grants are listed",
);
// Re-query each pass: a revoke rewrites the ledger and detaches the rows a
// snapshot taken before it would still name.
for (let revoked = 0; revoked < 2; revoked += 1) {
  const total = await page.locator("#identity-shares li.identity-row").count();
  await adaRows
    .first()
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll("#identity-shares li.identity-row").length <
      count,
    total,
    { timeout: 10000 },
  );
}
const left = await page
  .locator("#identity-shares li.identity-row", { hasText: "Ada Lovelace" })
  .count();
check(left === 0, "after revoke the recipient holds no standing access");
await snap(page, "04-grants-after-revoke");

// 4. Item Share once → drop ceremony, minted on this origin.
setStep("share-drop");
await go(page, "/vault");
await page.locator(".vtree__row", { hasText: "Deploy key" }).first().click();
const shareOnce = page.getByRole("button", { name: "Share once" });
await shareOnce.waitFor({ timeout: 10000 });
await shareOnce.click();
await page.getByRole("button", { name: "Seal and share" }).click();
await page.locator(".drop-card__link").waitFor({ timeout: 15000 });
const link = (await page.locator(".drop-card__link").innerText()).trim();
const code = (
  await page
    .locator(".frow", { hasText: "User code" })
    .locator(".frow__value")
    .innerText()
).trim();
check(
  link.includes("/claim#token=osc_clm_"),
  "drop link minted on this origin",
);
await snap(page, "05-item-drop-card");

// The recipient opens the link ON THIS TAB: an in-app navigation keeps the
// tab's in-memory vault key, which the device claim plane needs to answer a
// present. A second tab would have to Skip the front door into its own guest
// session — the wipe step 4 is ordered to avoid.
setStep("receive-drop");
const claimPath = (() => {
  const url = new URL(link);
  return `${url.pathname.slice(BASE.length)}${url.hash}`;
})();
await go(page, `/${claimPath}`);
await page.locator("#drop-user-code").waitFor({ timeout: 15000 });
await page.locator("#drop-user-code").fill(code);
await page.getByRole("button", { name: "Open drop" }).click();
const opened = page.locator(".codeblock");
await opened.waitFor({ timeout: 15000 });
check(
  (await opened.innerText()).includes("restore-share-pam-secret"),
  "recipient opened the drop and read the secret",
);
await snap(page, "06-drop-received");

// Single-use: the same link and code cannot open it twice.
setStep("drop-spent");
await go(page, "/vault");
await go(page, `/${claimPath}`);
await page.locator("#drop-user-code").waitFor({ timeout: 15000 });
await page.locator("#drop-user-code").fill(code);
await page.getByRole("button", { name: "Open drop" }).click();
const refused = await page
  .getByRole("img", { name: /already opened/i })
  .waitFor({ timeout: 15000 })
  .then(() => true)
  .catch(() => false);
check(refused, "a second open of the same drop is refused");
await snap(page, "07-drop-spent");

// The vault chrome never names the claim entry.
setStep("chrome-copy");
await go(page, "/vault");
const text = await page.evaluate(() => document.body.innerText);
check(!/Accept a claim|Open a claim/.test(text), "no claim copy in the shell");

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`\nPASS share-pam walk; screenshots in ${OUT}`);
await browser.close();
