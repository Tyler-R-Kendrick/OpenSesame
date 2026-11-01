/** Two-build evidence for password-manager connections and their shared BYO controls. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sealWithPin } from "./lib/pages-journey.mjs";
import { privateSharedTempDir } from "./lib/private-files.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(
  process.env.PAGES_VERIFY_DIST ?? path.join(here, "../dist"),
);
const phase = process.env.PAGES_CAPTURE_PHASE ?? "after";
if (!["before", "after"].includes(phase))
  throw new Error("Choose before or after capture phase");
const origin = process.env.PAGES_ORIGIN ?? "https://opensesame-labs.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "../../../work/evidence/backup-integrations/pages/browser"),
);
const raw = path.join(
  process.env.PAGES_CAPTURE_RAW ??
    privateSharedTempDir("opensesame-backup-evidence"),
  phase,
);
fs.mkdirSync(raw, { recursive: true });
fs.mkdirSync(out, { recursive: true });
const h = createHarness({ dist, origin, base, out });
const browser = await h.launch({ args: ["--no-sandbox"] });
const metrics = [];
async function visit(page, route) {
  await page.evaluate((href) => {
    history.pushState({}, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
}
async function enable(page) {
  await visit(page, "settings/features");
  const toggle = page.getByRole("switch", { name: "Connections", exact: true });
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-checked")) !== "true")
    await toggle.click();
}
async function measured(page) {
  return page.evaluate(() => ({
    fields: [
      ...document.querySelectorAll("main input, main select, main textarea"),
    ].map((node) => ({
      label:
        node.labels?.[0]?.textContent?.trim() ??
        node.getAttribute("aria-label"),
      tag: node.tagName,
      type: node.type,
      readonly: !!node.readOnly,
    })),
    providers: [...document.querySelectorAll("ul#password_managers a")].map(
      (node) => node.textContent.trim(),
    ),
    overflow: document.documentElement.scrollWidth > innerWidth,
    text: document.body.innerText,
  }));
}
const screens = [
  ["catalog", "settings/integrations#integration-password-managers"],
  ["1password", "settings/connections/1password"],
  ["proton-pass", "settings/connections/proton-pass"],
];
if (phase === "after") {
  for (const mode of ["local", "onepassword-connect", "infisical"])
    screens.push([`byo-${mode}`, "settings/connections/byo-secret-backend"]);
}
async function prepareScreen(page, screen) {
  if (screen === "catalog") {
    const group = page.locator("#integration-password-managers");
    await group.getByRole("link", { name: "1Password", exact: true }).waitFor();
    await group.scrollIntoViewIfNeeded();
    return;
  }
  const name = screen.startsWith("byo-")
    ? "BYO Secret Backend"
    : screen === "1password"
      ? "1Password"
      : "Proton Pass";
  await page.getByRole("heading", { name, exact: true }).waitFor();
  if (phase !== "after") return;
  const method = page.getByLabel("Connection method", { exact: true });
  await method.waitFor();
  if (screen.startsWith("byo-")) await method.selectOption(screen.slice(4));
}
try {
  for (const width of [1280, 390]) {
    const { page, context } = await h.newPage(browser, {
      device: { isMobile: width === 390, hasTouch: width === 390 },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await sealWithPin(page);
    await enable(page);
    for (const [screen, route] of screens) {
      h.setStep(`${phase}-${width}-${screen}`);
      await visit(page, route);
      await prepareScreen(page, screen);
      await page.waitForTimeout(250);
      const data = await measured(page);
      metrics.push({ width, screen, ...data });
      await page.screenshot({
        path: path.join(raw, `${width}-${screen}.png`),
        fullPage: true,
      });
      h.check(
        !data.overflow,
        `${width}: ${screen} fits without horizontal document overflow`,
      );
    }
    await context.close();
  }
} catch (error) {
  h.failures.push(`${h.step()}: ${error.stack ?? error}`);
} finally {
  await browser.close();
}
for (const entry of h.log.filter((entry) =>
  [
    "PAGE-ERROR",
    "console-error",
    "HTTP-ERROR",
    "MISSING-ASSET",
    "LOOPBACK-REQUEST",
  ].includes(entry.kind),
))
  h.failures.push(`${entry.kind}: ${entry.detail}`);
fs.writeFileSync(
  path.join(out, `${phase}-metrics.json`),
  `${JSON.stringify({ phase, origin, base, metrics, failures: h.failures, log: h.log }, null, 2)}\n`,
);
if (h.failures.length) throw new Error(h.failures.join("\n"));
console.log(
  `Captured ${phase} backup configuration at desktop and touch phone widths: ${out}`,
);
