/**
 * Numeric parity with the supplied 1663x946 reference, plus real idle/reveal proof.
 * PLAYWRIGHT_CHROMIUM=/path/to/chromium PAGES_VERIFY_DIST=/absolute/dist \
 *   node scripts/capture-lockscreen-parity.mjs <before|after> <raw-output-directory>
 * Before records the unchanged base; after enforces the reference contracts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkLockscreenGeometry,
  lockscreenGeometry,
} from "./lib/lockscreen-parity-geometry.mjs";
import { checkDialInk, measureDialInk } from "./lib/lockscreen-parity-ink.mjs";
import {
  measureIdleMotion,
  observeDoors,
} from "./lib/lockscreen-parity-motion.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import {
  PIN,
  lockVault,
  sealWithPin,
  unlockWithPin,
} from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
const [stage, rawOutput] = process.argv.slice(2);
if (!["before", "after"].includes(stage) || !rawOutput)
  throw new Error(
    "usage: capture-lockscreen-parity.mjs <before|after> <raw-output-directory>",
  );
const out = path.resolve(rawOutput, stage);
fs.mkdirSync(out, { recursive: true });
const dist =
  process.env.PAGES_VERIFY_DIST ??
  fileURLToPath(new URL("../dist", import.meta.url));
const origin = "https://opensesame-labs.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const harness = createHarness({ dist, origin, base, out });
const sizes = [
  { width: 1663, height: 946 },
  { width: 1280, height: 900 },
  { width: 1100, height: 900 },
  { width: 1024, height: 1366, touch: true },
  { width: 320, height: 568, touch: true },
  { width: 390, height: 844, touch: true },
  { width: 430, height: 932, touch: true },
  { width: 844, height: 390, touch: true },
  { width: 568, height: 320, touch: true },
];
const selected = process.env.LOCKSCREEN_SIZES?.split(",").map(Number);
const measurements = [];
const browser = await harness.launch();
const check = (ok, label) =>
  stage === "after"
    ? harness.check(Boolean(ok), label)
    : harness.record(ok ? "BASE-PASS" : "BASE-DIFF", label);

async function selectTheme(page, theme) {
  for (let tries = 0; tries < 3; tries++) {
    if ((await page.locator("html").getAttribute("data-theme")) === theme)
      return;
    await page
      .locator(".unlock__brand-tools")
      .getByRole("button", { name: /^Theme:/ })
      .click();
    await page.waitForTimeout(100);
  }
  throw new Error(`theme key did not select ${theme}`);
}

async function measure(page, label) {
  harness.setStep(label);
  const geometry = await page.evaluate(lockscreenGeometry);
  checkLockscreenGeometry(geometry, check);
  const ink = await measureDialInk(page, geometry);
  checkDialInk(ink, check);
  measurements.push({ label, geometry, ink });
  return geometry;
}

async function notesExpand(page, label) {
  const summary = page.locator(".unlock__notes-summary").first();
  if ((await summary.getAttribute("aria-expanded")) !== "true") {
    await summary.scrollIntoViewIfNeeded();
    await summary.scrollIntoViewIfNeeded();
    const reachable = await summary.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return node.contains(
        document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        ),
      );
    });
    check(
      reachable,
      "collapsed release-note summary remains reachable by pointer",
    );
    if (reachable) await summary.click();
    else {
      for (let tabs = 0; tabs < 40; tabs++) {
        if (await summary.evaluate((node) => node === document.activeElement))
          break;
        await page.keyboard.press("Tab");
      }
      await page.keyboard.press("Enter");
    }
  }
  await page.locator(".unlock__notes-body").first().waitFor();
  await page.waitForTimeout(250);
  await summary.scrollIntoViewIfNeeded();
  await measure(page, `${label}-notes-expanded`);
  await page.screenshot({
    path: path.join(out, `${label}-notes-expanded.png`),
    fullPage: false,
  });
  await summary.scrollIntoViewIfNeeded();
  const reachable = await summary.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return node.contains(
      document.elementFromPoint(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      ),
    );
  });
  check(
    reachable,
    "expanded release-note summary remains reachable by pointer",
  );
  measurements.push({ label: `${label}-notes-pointer`, reachable });
  if (reachable) await summary.click();
  else {
    for (let tabs = 0; tabs < 40; tabs++) {
      if (await summary.evaluate((node) => node === document.activeElement))
        break;
      await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Enter");
  }
  await page
    .locator(".unlock__notes-body")
    .first()
    .waitFor({ state: "detached" });
  await page.locator(".unlock").evaluate((node) => node.scrollTo(0, 0));
}

async function reducedMotion(page, label) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await lockVault(page);
  await page.waitForTimeout(700);
  const motion = await measureIdleMotion(page, true);
  const painted = (frame) =>
    page.viewportSize().width >= 1100
      ? frame.every((ring) => ring?.ink > 100)
      : frame.reduce((sum, ring) => sum + (ring?.ink ?? 0), 0) > 100;
  check(
    motion.changedRings === 0 && motion.frames.every(painted),
    "reduced motion leaves the decorative ring canvases static",
  );
  check(
    !motion.heroChanged && motion.heroFrames.every(Number.isFinite),
    "reduced-motion hero remains painted and static",
  );
  measurements.push({ label: `${label}-reduced-motion`, motion });
  const viewport = page.viewportSize();
  await page.setViewportSize({
    width: viewport.width + 1,
    height: viewport.height,
  });
  await page.setViewportSize(viewport);
  await page.waitForTimeout(250);
  const resizedMotion = await measureIdleMotion(page, true);
  check(
    resizedMotion.changedRings === 0 && resizedMotion.frames.every(painted),
    "reduced-motion rings remain painted and static after live resize",
  );
  measurements.push({
    label: `${label}-reduced-resized`,
    motion: resizedMotion,
  });
  await page.screenshot({
    path: path.join(out, `${label}-reduced-motion.png`),
    fullPage: false,
  });
  await unlockWithPin(page);
}

async function walk(size) {
  const label = `${size.width}x${size.height}`;
  const { page, context } = await harness.newPage(browser, {
    device: size.touch
      ? phoneContext(size)
      : { viewport: { width: size.width, height: size.height } },
  });
  try {
    await page.emulateMedia({
      colorScheme: "dark",
      reducedMotion: "no-preference",
    });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await sealWithPin(page);
    await lockVault(page);
    await page.locator(".unlock__hero canvas").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1800);
    for (const theme of ["dark", "light"]) {
      await selectTheme(page, theme);
      await page.waitForTimeout(250);
      await measure(page, `${label}-${theme}`);
      await page.screenshot({
        path: path.join(out, `${label}-${theme}.png`),
        fullPage: false,
      });
    }
    await selectTheme(page, "dark");
    const motion = await measureIdleMotion(page, false);
    check(
      motion.changedRings > 0,
      "idle cipher rings visibly repaint over time",
    );
    check(
      motion.heroChanged,
      "large hero wordmark keeps its authored live animation",
    );
    measurements.push({ label: `${label}-idle-motion`, motion });
    await notesExpand(page, label);
    const resized =
      size.width >= 1100
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 };
    await page.setViewportSize(resized);
    await page.waitForTimeout(500);
    await measure(page, `${label}-resized-${resized.width}`);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(500);
    const doors = await observeDoors(
      page,
      PIN,
      path.join(out, `${label}-doors.png`),
    );
    check(
      doors.shifts.length >= 3 && Math.max(...doors.shifts) >= 90,
      "real PIN unlock advances the opening doors and reaches the vault",
    );
    measurements.push({ label: `${label}-doors`, doors });
    await reducedMotion(page, label);
    console.log(`${stage} ${label} complete`);
  } finally {
    await context.close();
  }
}
try {
  for (const size of sizes)
    if (!selected || selected.includes(size.width)) await walk(size);
} finally {
  await browser.close();
  fs.writeFileSync(
    path.join(out, "measurements.json"),
    JSON.stringify(measurements, null, 2),
  );
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(
      { stage, failures: harness.failures, log: harness.log },
      null,
      2,
    ),
  );
}
if (harness.failures.length) {
  console.error(harness.failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `${stage}: ${measurements.length} lockscreen measurements; real idle, doors and reduced-motion checks complete`,
  );
