// Three isolated Chromium processes, static assets only, manual signaling only.
// The runner moves invitation, offer and answer strings; RTC carries the data.
// Transport is the browser's RTCPeerConnection (strict-direct: iceServers empty).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { doorGuest } from "./lib/front-door.mjs";
import { joinerSaves, ownerSeesSave } from "./lib/live-edit-walk.mjs";
import {
  PRIVATE_ITEM,
  SHARED_ITEM,
  fieldLabel,
  itemAbsent,
  joinerSeesCatalog,
  revealButton,
} from "./lib/live-item-labels.mjs";
import {
  WATCH_RTC,
  endSession,
  joinerAsks,
  joinerConnects,
  openLive,
  ownerAdmitsByHand,
  startSession,
} from "./lib/live-join-walk.mjs";
import { addCapabilities } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const origin = "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const dist = path.resolve(here, "../dist");
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ?? path.join(root, "artifacts/browser-sessions"),
);
const secret = "correct-horse-battery-staple-2026";
const edited = "rotated-horse-battery-staple-2026";
const privateSecret = "payroll-not-shared-2026";
const joinerName = "Ada";

if (!fs.existsSync(path.join(dist, "index.html"))) {
  throw new Error("Build Pages before verify-browser-sessions.");
}
fs.mkdirSync(out, { recursive: true });
const indexSha = createHash("sha256")
  .update(fs.readFileSync(path.join(dist, "index.html")))
  .digest("hex");
console.log(
  "topology=three-isolated-browser-processes-same-host; mode=strict-direct; externalServices=[]; localFixtures=[production-static-dist]; testTrust=playwright-route-to-dist",
);
console.log(`rich Pages index SHA-256 ${indexSha}`);

const harness = createHarness({ dist, origin, base, out });
const { log, failures, check, setStep } = harness;

function launch() {
  return chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM || chromium.executablePath(),
    headless: true,
    args: [
      "--allow-loopback-in-peer-connection",
      "--disable-features=WebRtcHideLocalIpsWithMdns,LocalNetworkAccessChecks",
    ],
  });
}

const spaFallbackConsole =
  "Failed to load resource: the server responded with a status of 404 (Not Found)";

async function device(browser, options = {}) {
  const made = await harness.newPage(browser, options);
  await made.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await made.context.addInitScript(WATCH_RTC);
  made.page.on("console", (message) => {
    if (message.type() !== "error") return;
    // GitHub Pages answers a route with index.html and status 404. The
    // harness already admits that one document when expectedFallbackUrl is set.
    if (
      options.expectedFallbackUrl &&
      message.location().url === options.expectedFallbackUrl &&
      message.text() === spaFallbackConsole
    ) {
      return;
    }
    harness.record("CONSOLE-ERROR", message.text().slice(0, 400));
  });
  return made;
}

/** New item is a secret (ADR 0153): a name and one concealed value. */
async function createSecret(page, { name, value }) {
  const create = page.getByRole("link", { name: "New item", exact: true });
  await create.first().waitFor({ timeout: 20_000 });
  await create.first().click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Secret value", { exact: true }).fill(value);
  await page
    .getByRole("button", { name: "Save item", exact: true })
    .first()
    .click();
  await page.getByRole("heading", { name, exact: true }).waitFor({
    timeout: 20_000,
  });
}

/** Empty device: Join, then the always-on drop claim ceremony. No vault. */
async function startup(browser) {
  setStep("startup-join");
  const { page } = await device(browser, {
    expectedFallbackUrl: `${origin}${base}claim`,
  });
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Join a session" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Join a session" }),
  ).toBeVisible();
  check(true, "Join: startup road without a local vault passed");
  setStep("drop-claim");
  await page.goto(`${origin}${base}claim`, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { level: 1, name: "Open a drop" }),
  ).toBeVisible();
  check(
    !(await page.locator("body").innerText()).includes("Accept a claim"),
    "Drop receive: no Accept a claim copy",
  );
  check(true, "Drop receive: empty device reached Open a drop passed");
  await page.close();
}

async function hostVault(page) {
  setStep("owner-vault");
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await doorGuest(page).click();
  await createSecret(page, { name: SHARED_ITEM.name, value: secret });
  await createSecret(page, { name: PRIVATE_ITEM.name, value: privateSecret });
  await addCapabilities(page, ["Live sessions"]);
}

const browsers = await Promise.all([launch(), launch(), launch()]);
console.log(`browser-processes=${browsers.length}`);
try {
  await startup(browsers[0]);
  setStep("owner");
  const owner = await device(browsers[1]);
  await hostVault(owner.page);
  const { panel, code, link } = await startSession(owner.page);
  check(
    code && link.includes("#live="),
    "owner published a strict-direct link",
  );
  check(
    !/\.[\w-]{87}\.[\w-]{43}\./.test(link),
    "with no route named, the link names no server",
  );

  setStep("joiner");
  const joiner = await device(browsers[2], {
    device: {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
    },
  });
  const request = await joinerAsks(joiner.page, {
    link,
    code,
    name: joinerName,
  });
  const reply = await ownerAdmitsByHand(owner.page, panel, request, joinerName);
  await joinerConnects(joiner.page, reply);
  await joinerSeesCatalog(joiner.page);
  await revealButton(joiner.page, SHARED_ITEM).click();
  await expect(joiner.page.getByText(secret)).toBeVisible({ timeout: 45_000 });
  check(
    (await joiner.page.getByText(privateSecret).count()) === 0 &&
      (await itemAbsent(joiner.page, PRIVATE_ITEM)),
    "scoped live view: the unshared item was not projected",
  );
  const made = [
    ...(await owner.page.evaluate(() => window.__rtcConfigs ?? [])),
    ...(await joiner.page.evaluate(() => window.__rtcConfigs ?? [])),
  ].map((raw) => JSON.parse(raw));
  check(
    made.length > 0 &&
      made.every((config) => (config.iceServers ?? []).length === 0),
    "strict-direct: every peer connection had no ICE server",
  );
  const connected = await joiner.page.evaluate(() =>
    (window.__rtcPeers ?? []).some((pc) => pc.connectionState === "connected"),
  );
  check(connected, "three-process RTC journey passed");

  setStep("lifecycle");
  await endSession(panel);
  await joiner.page
    .getByRole("img", { name: "The session ended" })
    .waitFor({ timeout: 15_000 });
  check(
    (await joiner.page.getByText(secret).count()) === 0,
    "revocation: ending the session dropped the value",
  );
  await joiner.page.waitForFunction(
    () =>
      (window.__rtcPeers ?? []).length > 0 &&
      (window.__rtcPeers ?? []).every((pc) =>
        ["closed", "disconnected", "failed"].includes(pc.connectionState),
      ),
    undefined,
    { timeout: 15_000 },
  );
  check(true, "lifecycle: session end retired the peer connection passed");
  // The live panel is still the owner's; opening it again must not revive a value.
  await openLive(owner.page);
  check(
    (await owner.page.getByText(secret).count()) === 0,
    "lifecycle: the owner no longer shows the shared secret",
  );

  setStep("edit");
  const again = await startSession(owner.page, { policy: "edit" });
  check(
    Boolean(again.code) && again.link.includes("#live="),
    "owner published an edit session",
  );
  const editRequest = await joinerAsks(joiner.page, {
    link: again.link,
    code: again.code,
    name: joinerName,
  });
  const editReply = await ownerAdmitsByHand(
    owner.page,
    again.panel,
    editRequest,
    joinerName,
  );
  await joinerConnects(joiner.page, editReply);
  await joinerSaves(joiner.page, {
    label: fieldLabel(SHARED_ITEM),
    value: edited,
  });
  check(
    (await joiner.page.getByText(privateSecret).count()) === 0 &&
      (await itemAbsent(joiner.page, PRIVATE_ITEM)),
    "edit session: the unshared item was not projected",
  );
  await ownerSeesSave(owner.page, {
    name: SHARED_ITEM.name,
    value: edited,
    previous: secret,
  });
  check(
    (await owner.page.getByText(edited, { exact: true }).count()) > 0 &&
      (await owner.page.getByText(secret, { exact: true }).count()) === 0,
    "authorized edit: the owner observed the joiner save",
  );
  check(
    (await owner.page.getByText(privateSecret, { exact: true }).count()) === 0,
    "authorized edit: the unshared secret stayed off the owner's item",
  );
  const later = [
    ...(await owner.page.evaluate(() => window.__rtcConfigs ?? [])),
    ...(await joiner.page.evaluate(() => window.__rtcConfigs ?? [])),
  ].map((raw) => JSON.parse(raw));
  check(
    later.length > 0 &&
      later.every((config) => (config.iceServers ?? []).length === 0),
    "edit session stayed strict-direct",
  );
} catch (error) {
  failures.push(
    `[${log.at(-1)?.step ?? "?"}] ${error instanceof Error ? error.message : error}`,
  );
} finally {
  await Promise.all(browsers.map((browser) => browser.close()));
}

for (const entry of log) {
  if (entry.kind === "PAGE-ERROR" || entry.kind === "CONSOLE-ERROR") {
    failures.push(`[${entry.step}] ${entry.kind} ${entry.detail}`);
  }
}
const external = log.filter((entry) => entry.kind === "external-request");
if (external.length > 0) {
  failures.push(
    `requests left the origin: ${external.map((entry) => entry.detail).join(", ")}`,
  );
}
fs.writeFileSync(path.join(out, "log.json"), JSON.stringify(log, null, 2));
fs.writeFileSync(
  path.join(out, "index.sha256"),
  `${indexSha}  apps/pages/dist/index.html\n`,
);
for (const entry of log) {
  if (entry.kind === "PASS") console.log(`PASS ${entry.detail}`);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("Join: startup road without a local vault passed");
console.log("lifecycle: session end retired the peer connection passed");
console.log("three-process RTC journey passed");
console.log(`ALL CHECKS PASSED — artifacts in ${out}`);
process.exit(0);
