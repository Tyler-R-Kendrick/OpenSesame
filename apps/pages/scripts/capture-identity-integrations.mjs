/** Production-origin identity UI evidence, using the same routes the catalog links to. */
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
  throw new Error("PAGES_CAPTURE_PHASE must be before or after");
const origin = process.env.PAGES_ORIGIN ?? "https://opensesame-labs.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(
      here,
      "../../../work/evidence/identity-integrations/pages/browser",
    ),
);
const rawRoot = path.resolve(
  process.env.PAGES_CAPTURE_RAW ??
    privateSharedTempDir("opensesame-identity-evidence"),
);
const raw = path.join(rawRoot, phase);
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(raw, { recursive: true });
const harness = createHarness({ dist, origin, base, out });
const browser = await harness.launch({ args: ["--no-sandbox"] });
const metrics = [];
const screens = [
  ["catalog", "settings/integrations"],
  ["better-auth", "settings/connections/better-auth"],
  ...(phase === "after"
    ? [
        ["byo-oidc", "settings/connections/byo-identity"],
        ["byo-saml", "settings/connections/byo-identity"],
        ["byo-ldap", "settings/connections/byo-identity"],
      ]
    : []),
];
async function visit(page, route) {
  await page.evaluate((href) => {
    history.pushState({}, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
  await page.waitForTimeout(900);
}
async function enableConnections(page) {
  await visit(page, "settings/features");
  const toggle = page.getByRole("switch", { name: "Connections", exact: true });
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-checked")) !== "true")
    await toggle.click();
}
async function measure(page) {
  return page.evaluate(() => ({
    text: document.body.innerText,
    fields: [
      ...document.querySelectorAll("main input, main select, main textarea"),
    ].map((node) => ({
      tag: node.tagName,
      type: node.type,
      label:
        node.labels?.[0]?.textContent?.trim() ??
        node.getAttribute("aria-label"),
      readonly: Boolean(node.readOnly),
    })),
    identityProviders: [...document.querySelectorAll("ul#identity a")].map(
      (node) => node.textContent.trim(),
    ),
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
}
try {
  for (const width of [1280, 390]) {
    const { page, context } = await harness.newPage(browser, {
      device: { isMobile: width === 390, hasTouch: width === 390 },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await sealWithPin(page);
    await enableConnections(page);
    for (const [screen, route] of screens) {
      harness.setStep(`${phase}-${width}-${screen}`);
      await visit(page, route);
      if (screen === "catalog")
        await page
          .getByRole("link", { name: "Better Auth", exact: true })
          .waitFor();
      if (screen.startsWith("byo-"))
        await page
          .getByLabel("Protocol", { exact: true })
          .selectOption(screen.slice(4));
      const data = await measure(page);
      metrics.push({ width, screen, ...data });
      await page.screenshot({
        path: path.join(raw, `${width}-${screen}.png`),
        fullPage: true,
      });
      harness.check(!data.overflow, `${width}: ${screen} fits the viewport`);
      if (phase === "after" && screen !== "catalog")
        harness.check(
          data.fields.length > 0,
          `${width}: ${screen} configuration controls are present`,
        );
    }
    await context.close();
  }
} finally {
  await browser.close();
  fs.writeFileSync(
    path.join(out, `${phase}-metrics.json`),
    JSON.stringify(
      {
        phase,
        origin,
        base,
        metrics,
        log: harness.log,
        failures: harness.failures,
      },
      null,
      2,
    ),
  );
}
for (const entry of harness.log.filter((entry) =>
  [
    "PAGE-ERROR",
    "console-error",
    "HTTP-ERROR",
    "MISSING-ASSET",
    "LOOPBACK-REQUEST",
  ].includes(entry.kind),
))
  harness.failures.push(`${entry.kind}: ${entry.detail}`);
fs.writeFileSync(
  path.join(out, `${phase}-capture.json`),
  JSON.stringify(
    {
      phase,
      origin,
      base,
      metrics,
      log: harness.log,
      failures: harness.failures,
    },
    null,
    2,
  ),
);
if (harness.failures.length) throw new Error(harness.failures.join("\n"));
console.log(
  `Captured ${phase}: desktop and phone identity catalog and configuration; ${out}`,
);
