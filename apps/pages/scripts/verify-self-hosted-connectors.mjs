/** Real static-build browser contract for provider-specific connector configuration. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observeHttpFailures } from "./lib/http-failures.mjs";
import { apiKeyFlow, oauthFlow } from "./lib/linear-browser-flows.mjs";
import { linearFallbacks } from "./lib/linear-fallback-contract.mjs";
import { routeLinearProvider } from "./lib/linear-provider-contract.mjs";
import { recoveryFlow } from "./lib/linear-recovery-browser-flows.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { sealWithPin } from "./lib/pages-journey.mjs";
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
const fallbacks = linearFallbacks(harness);

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
  for (const name of ["App Scopes", "User Scopes"])
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

const browser = await harness.launch();
let activePage;
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
    activePage = page;
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin,
    });
    const authority = await routeLinearProvider(context, {
      origin,
      base,
      check,
    });
    fallbacks.observe(page, authority);
    context.on("page", (popup) => {
      observeHttpFailures(popup, harness.record);
      fallbacks.observe(popup, authority);
      popup.on("pageerror", (error) =>
        harness.record("PAGE-ERROR", error.message),
      );
    });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await sealWithPin(page);
    await enableConnections(page);
    await visit(page, "settings/general");
    await page.getByRole("button", { name: "Night", exact: true }).click();
    await visit(page, "connections/linear");
    setStep(`${label}-linear`);
    await providerSpecific(page, label);
    if (label === "desktop") await keyboardControls(page, label);
    await harness.snap(page, `${label}-authorization-form`, {
      fullPage: false,
    });
    await apiKeyFlow({ harness, visit, verifyIcon }, page, label, authority);
    await visit(page, "connections/linear");
    await oauthFlow(harness, page, label, authority, visit);
    await recoveryFlow({ harness, visit }, page, label, authority);
    await context.close();
  }
} catch (error) {
  harness.record("FAIL", String(error?.stack ?? error));
  failures.push(String(error));
  if (activePage && !activePage.isClosed()) {
    fs.writeFileSync(
      path.join(out, "failure.txt"),
      await activePage.locator("body").innerText(),
    );
    await activePage.screenshot({
      path: path.join(out, "failure.png"),
      fullPage: true,
    });
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
const hard = log.filter(
  (entry) =>
    [
      "LOOPBACK-REQUEST",
      "HTTP-ERROR",
      "PAGE-ERROR",
      "console-error",
      "ON-SCREEN",
      "MISSING-ASSET",
    ].includes(entry.kind) && fallbacks.unexpected(entry),
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
    "ALL CHECKS PASSED — authenticated Linear protocol, sealed reload and independent OAuth actors",
  );
