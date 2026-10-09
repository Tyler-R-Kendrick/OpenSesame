/** Real static-build browser contract for provider-specific connector configuration. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doorGuest } from "./lib/front-door.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { waitOpen } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.EVIDENCE_DIST ?? path.resolve(here, "..", "dist");
const origin = "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ?? "work/self-hosted-connectors",
);
if (!fs.existsSync(path.join(dist, "index.html"))) {
  throw new Error(`No static build at ${dist}; build @opensesame/pages first.`);
}
fs.mkdirSync(out, { recursive: true });
const harness = createHarness({ dist, origin, base, out });
const { check, log, failures, setStep } = harness;

async function visit(page, route) {
  await page.evaluate((href) => {
    history.pushState(null, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
  await page.waitForTimeout(900);
}

async function enableConnections(page) {
  await visit(page, "settings/capabilities");
  const toggle = page.getByRole("switch", { name: "Connections", exact: true });
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-checked")) !== "true")
    await toggle.click();
  await page.waitForTimeout(900);
}

async function resumeGuest(page) {
  const skip = doorGuest(page);
  const guest = page.getByRole("button", {
    name: "Continue as guest",
    exact: true,
  });
  const open = page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first();
  await skip.or(guest).or(open).first().waitFor({ timeout: 20000 });
  if (!(await open.isVisible().catch(() => false))) {
    await skip.or(guest).first().click();
  }
  await waitOpen(page);
}

async function pngFixture(page, size) {
  const url = await page.evaluate((dimension) => {
    const canvas = document.createElement("canvas");
    canvas.width = dimension;
    canvas.height = dimension;
    const context = canvas.getContext("2d");
    context.fillStyle = "#5d5bdf";
    context.fillRect(0, 0, dimension, dimension);
    return canvas.toDataURL("image/png");
  }, size);
  const file = path.join(out, `icon-${size}.png`);
  fs.writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
  return file;
}

async function verifyIcon(page, label) {
  const input = page.getByLabel("Icon", { exact: true });
  await input.setInputFiles(await pngFixture(page, 640));
  const icon = page.getByRole("img", { name: "Connector icon", exact: true });
  await icon.waitFor();
  const valid = await icon.getAttribute("src");
  check(
    (valid ?? "").startsWith("data:image/png;base64,"),
    `${label}: valid PNG icon is previewed`,
  );
  await input.setInputFiles(await pngFixture(page, 16));
  await page
    .getByRole("img", {
      name: "The icon must be at least 640 × 640 pixels.",
      exact: true,
    })
    .waitFor();
  check(
    (await icon.getAttribute("src")) === valid,
    `${label}: undersized icon is rejected without replacing valid icon`,
  );
  return valid;
}

async function providerSpecific(page, label) {
  await page.getByRole("heading", { name: /Configure$/ }).waitFor();
  const text = await page.locator("main").innerText();
  check(
    !/Vercel Connect|Vercel access token|Vercel tokens|Team ID|Project ID/.test(
      text,
    ),
    `${label}: Linear contains no Vercel configuration`,
  );
  for (const name of ["Managed", "Bring Your Own"])
    check(
      await page.getByRole("radio", { name, exact: true }).isVisible(),
      `${label}: ${name} mode`,
    );
  for (const name of ["App Scopes", "User Scopes", "Webhook Resource Types"])
    check(
      await page.getByLabel(name, { exact: true }).isVisible(),
      `${label}: ${name}`,
    );
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    rows: [
      ...document.querySelectorAll(".cx-mode, .cx-selection > summary"),
    ].map((node) => node.getBoundingClientRect().height),
  }));
  check(
    layout.document <= layout.viewport,
    `${label}: configuration does not overflow horizontally`,
  );
  check(
    layout.rows.every((height) => height >= 44),
    `${label}: modes and scope controls are at least 44px`,
  );
  for (const [name, count] of [
    ["App Scopes", 4],
    ["User Scopes", 2],
    ["Webhook Resource Types", 2],
  ]) {
    check(
      (await page.getByLabel(name, { exact: true }).innerText()).includes(
        `${count} selected`,
      ),
      `${label}: ${name} defaults to ${count} selections`,
    );
  }
  check(
    (await page.getByLabel("Icon", { exact: true }).count()) === 1,
    `${label}: provider icon upload`,
  );
}

async function keyboardControls(page, label) {
  const managed = page.getByRole("radio", { name: "Managed", exact: true });
  const byo = page.getByRole("radio", { name: "Bring Your Own", exact: true });
  await managed.focus();
  await page.keyboard.press("ArrowRight");
  check(await byo.isChecked(), `${label}: arrow key selects Bring Your Own`);
  await page.keyboard.press("ArrowLeft");
  check(await managed.isChecked(), `${label}: arrow key selects Managed`);
  const summary = page.getByLabel("App Scopes", { exact: true });
  await summary.focus();
  await page.keyboard.press("Enter");
  const read = page
    .locator("details")
    .filter({ has: summary })
    .getByRole("checkbox", { name: "read", exact: true });
  check(
    await read.isVisible(),
    `${label}: Enter opens native scope disclosure`,
  );
  await read.focus();
  await page.keyboard.press("Space");
  check(
    !(await read.isChecked()),
    `${label}: Space clears native scope checkbox`,
  );
  await page.keyboard.press("Space");
  check(
    await read.isChecked(),
    `${label}: Space selects native scope checkbox`,
  );
  await summary.focus();
  await page.keyboard.press("Enter");
  check(
    !(await read.isVisible()),
    `${label}: Enter closes native scope disclosure`,
  );
}

async function createLocal(page, label) {
  await page
    .getByLabel("Select a Linear workspace", { exact: true })
    .fill("browser-contract-workspace");
  await page
    .getByLabel("Connector Name", { exact: true })
    .fill(`${label}-linear-contract`);
  await page
    .getByRole("radio", { name: "Bring Your Own", exact: true })
    .check();
  check(
    await page
      .getByRole("radio", { name: "Bring Your Own", exact: true })
      .isChecked(),
    `${label}: BYO mode changes configuration`,
  );
  await page.getByRole("radio", { name: "Managed", exact: true }).check();
  check(
    (await page.getByLabel("Connector Name", { exact: true }).inputValue()) ===
      `${label}-linear-contract`,
    `${label}: mode changes preserve connector details`,
  );
  await harness.snap(page, `${label}-configure`, { fullPage: false });
  const iconSource = await verifyIcon(page, label);
  await page.getByText("Linear OAuth application", { exact: true }).click();
  await page
    .getByLabel("Client ID", { exact: true })
    .fill("browser-contract-client");
  await page
    .getByLabel("Client secret", { exact: true })
    .fill("test-only-not-a-real-secret");
  const webhook = page.getByLabel("Webhook Resource Types", { exact: true });
  await webhook.click();
  await page
    .locator("details")
    .filter({ has: webhook })
    .getByRole("checkbox", { name: "Project", exact: true })
    .check();
  await webhook.click();
  const create = page.getByRole("button", {
    name: "Create Connector",
    exact: true,
  });
  check(
    await create.isEnabled(),
    `${label}: configured provider can be saved locally`,
  );
  await create.click();
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: "networkidle" });
  await resumeGuest(page);
  await visit(page, "connections/linear");
  return iconSource;
}

async function verifyPersisted(page, label, iconSource) {
  setStep(`${label}-persisted`);
  check(
    (await page
      .getByRole("img", { name: "Connector icon", exact: true })
      .getAttribute("src")) === iconSource,
    `${label}: valid icon persists after guest reload`,
  );
  check(
    (await page
      .getByLabel("Select a Linear workspace", { exact: true })
      .inputValue()) === "browser-contract-workspace",
    `${label}: workspace survives guest reload`,
  );
  check(
    (await page.getByLabel("Connector Name", { exact: true }).inputValue()) ===
      `${label}-linear-contract`,
    `${label}: connector name survives guest reload`,
  );
  check(
    await page
      .getByRole("img", {
        name: "Provider authorization pending",
        exact: true,
      })
      .isVisible(),
    `${label}: configuration remains pending provider authorization`,
  );
  const savedWebhook = page.getByLabel("Webhook Resource Types", {
    exact: true,
  });
  await savedWebhook.click();
  check(
    await page
      .locator("details")
      .filter({ has: savedWebhook })
      .getByRole("checkbox", { name: "Project", exact: true })
      .isChecked(),
    `${label}: webhook choices survive reload`,
  );
  await savedWebhook.click();
}

async function verifyEditing(page, label) {
  await page
    .getByText("Linear OAuth application", { exact: false })
    .first()
    .click();
  check(
    (await page.getByLabel("Client secret", { exact: true }).inputValue()) ===
      "",
    `${label}: saved credential is absent from editable input`,
  );
  const save = page.getByRole("button", {
    name: "Save connector",
    exact: true,
  });
  check(
    await save.isEnabled(),
    `${label}: unchanged application retains credential for settings edits`,
  );
  await page
    .getByLabel("Connector Name", { exact: true })
    .fill(`${label}-linear-edited`);
  await save.click();
  await page.waitForTimeout(900);
  check(
    (await page.getByLabel("Connector Name", { exact: true }).inputValue()) ===
      `${label}-linear-edited`,
    `${label}: saved connector can be edited`,
  );
  await visit(page, "connections/connected");
  const connectedText = await page.locator("main").innerText();
  check(
    !/test-only-not-a-real-secret/.test(connectedText),
    `${label}: provider secret absent from connection list`,
  );
  await visit(page, "connections/linear");
  check(
    (await page.getByLabel("Connector Name", { exact: true }).inputValue()) ===
      `${label}-linear-edited`,
    `${label}: edited configuration survives remount`,
  );
  await visit(page, "connections/slack");
  const slack = await page.locator("main").innerText();
  check(
    /Slack/.test(slack) &&
      !/Linear workspace|Vercel access token|Team ID|Project ID/.test(slack),
    `${label}: switching provider shows Slack configuration`,
  );
  check(
    (await page.getByLabel("Connector Name", { exact: true }).inputValue()) !==
      `${label}-linear-edited`,
    `${label}: switching provider does not retain Linear settings`,
  );
}

const browser = await harness.launch();
try {
  for (const [label, device] of [
    ["desktop", { viewport: { width: 1280, height: 900 } }],
    ["phone", phoneContext({ width: 390, height: 844 })],
  ]) {
    setStep(`${label}-guest`);
    const { page, context } = await harness.newPage(browser, {
      device,
      expectedFallbackUrl: `${origin}${base}connections/linear`,
    });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await doorGuest(page).click();
    await waitOpen(page);
    await enableConnections(page);
    await visit(page, "connections/linear");
    setStep(`${label}-linear`);
    await providerSpecific(page, label);
    if (label === "desktop") await keyboardControls(page, label);
    const iconSource = await createLocal(page, label);
    await verifyPersisted(page, label, iconSource);
    await verifyEditing(page, label);
    await context.close();
  }
} finally {
  await browser.close();
}
fs.writeFileSync(
  path.join(out, "log.json"),
  `${JSON.stringify(log, null, 2)}\n`,
);
for (const entry of log.filter((entry) =>
  ["PASS", "FAIL"].includes(entry.kind),
))
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
const vercel = log.filter((entry) =>
  /api\.vercel\.com|\/api\/connect/.test(entry.detail),
);
if (failures.length || hard.length || vercel.length) {
  for (const entry of [...hard, ...vercel])
    console.error(`${entry.kind}: ${entry.detail}`);
  process.exitCode = 1;
} else
  console.log(
    "ALL CHECKS PASSED — static provider configuration without Vercel requests",
  );
