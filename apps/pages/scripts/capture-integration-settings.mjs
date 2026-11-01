/** Same production UI journey on both builds, with measured desktop/touch-phone frames. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { sealWithPin } from "./lib/pages-journey.mjs";
import { privateSharedTempDir } from "./lib/private-files.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(
  process.env.PAGES_VERIFY_DIST ?? path.join(here, "../dist"),
);
const phase = process.env.PAGES_CAPTURE_PHASE ?? "after";
if (!["before", "after"].includes(phase))
  throw new Error("Choose before or after");
const origin = "https://opensesame-labs.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(
      here,
      "../../../work/evidence/integration-settings/pages/browser",
    ),
);
const raw = path.join(
  process.env.PAGES_CAPTURE_RAW ??
    privateSharedTempDir("opensesame-integration-followup-evidence"),
  phase,
);
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(raw, { recursive: true });
const h = createHarness({ dist, origin, base, out });
const metrics = [];
const browser = await h.launch({ args: ["--no-sandbox"] });
async function visit(page, route) {
  await page.evaluate((href) => {
    history.pushState({}, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
}
async function enable(page) {
  await visit(page, "settings/features");
  for (const name of ["Connections", "On-device model"]) {
    const toggle = page.getByRole("switch", { name, exact: true });
    await toggle.waitFor();
    if ((await toggle.getAttribute("aria-checked")) !== "true")
      await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  }
}
async function prepare(page, screen) {
  if (screen === "local-storage") {
    await visit(page, "settings/integrations#integration-local-storage");
    await page.locator("#integration-payments").waitFor();
    await page.locator("#integration-payments").evaluate((node) => {
      node.scrollIntoView({ block: "end" });
      let scroller = node.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight)
        scroller = scroller.parentElement;
      scroller?.scrollBy(0, -80);
    });
    return;
  }
  if (screen === "features-ai" || screen === "integrations-ai") {
    const section =
      screen === "features-ai"
        ? "features#feature-ai"
        : "integrations#integration-ai";
    await visit(page, `settings/${section}`);
    if (
      (phase === "before" && screen === "integrations-ai") ||
      (phase === "after" && screen === "features-ai")
    )
      await page.getByLabel("Voice model", { exact: true }).waitFor();
    await page.locator(`#${section.split("#")[1]}`).scrollIntoViewIfNeeded();
    return;
  }
  await visit(page, `settings/connections/${screen}`);
  await page
    .getByRole("heading", {
      name: screen === "tailscale" ? "Tailscale" : "BYO AI",
      exact: true,
    })
    .waitFor();
  if (phase === "after")
    await page
      .getByLabel(
        screen === "tailscale" ? "Browser node hostname" : "API family",
        { exact: true },
      )
      .waitFor();
}
async function capture(page, width, screen) {
  const data = await page.evaluate(() => ({
    localStorageGroup: document.querySelectorAll("#integration-local-storage")
      .length,
    localStorageLinks: [
      ...document.querySelectorAll("#integration-local-storage a"),
    ].map((node) => node.textContent.trim()),
    localStorageNavigation: document.querySelectorAll(
      'a[href*="#integration-local-storage"]',
    ).length,
    selects: [...document.querySelectorAll("main select")].map((node) => ({
      label:
        node.labels?.[0]?.textContent.trim() ?? node.getAttribute("aria-label"),
      options: [...node.options].map((option) => ({
        text: option.text,
        disabled: option.disabled,
      })),
    })),
    fields: [
      ...document.querySelectorAll("main input,main select,main textarea"),
    ].map((node) => ({
      label:
        node.labels?.[0]?.textContent.trim() ?? node.getAttribute("aria-label"),
      type: node.type,
      readonly: !!node.readOnly,
    })),
    overflow: document.documentElement.scrollWidth > innerWidth,
    text: document.body.innerText,
  }));
  metrics.push({ width, screen, ...data });
  await page.screenshot({
    path: path.join(raw, `${width}-${screen}.png`),
    fullPage: true,
  });
  h.check(
    !data.overflow,
    `${width}: ${screen} has no horizontal document overflow`,
  );
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
    const screens = [
      "local-storage",
      "integrations-ai",
      "features-ai",
      "tailscale",
    ];
    if (phase === "after") screens.push("byo-ai");
    for (const screen of screens) {
      h.setStep(`${phase}-${width}-${screen}`);
      await prepare(page, screen);
      await capture(page, width, screen);
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
  `${JSON.stringify(
    {
      phase,
      compiledSourceCommit: process.env.PAGES_COMPILED_SOURCE_COMMIT ?? null,
      origin,
      base,
      metrics,
      failures: h.failures,
      log: h.log,
    },
    null,
    2,
  )}\n`,
);
if (h.failures.length) throw new Error(h.failures.join("\n"));
console.log(`PASS ${phase} integration settings production captures: ${out}`);
