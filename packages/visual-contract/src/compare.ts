/**
 * Pixel-diff contract between a freshly rendered apps/pages screen and its
 * checked-in .impeccable/screenshots/<name>.png baseline.
 *
 * Two modes:
 *  - default (compare): pixelmatch the capture against the baseline, fail
 *    the test past a 1.5% mismatch budget, and leave a diff PNG under
 *    output/ for a human to look at.
 *  - VISUAL_UPDATE=1 (rebaseline): overwrite the baseline in place with the
 *    fresh capture instead of comparing. This is an intentional, reviewed
 *    action — see the package README — never something a routine run does
 *    on its own.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, TestInfo } from "@playwright/test";
import { expect } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

export const BASELINE_DIR = join(REPO_ROOT, ".impeccable", "screenshots");
export const OUTPUT_DIR = join(PACKAGE_ROOT, "output");

/** pixelmatch's own per-pixel perceptual-color-difference sensitivity. */
const PIXELMATCH_THRESHOLD = 0.1;
/** Share of pixels allowed to differ before the contract is considered broken. */
const MAX_DIFF_RATIO = 0.015;

export function isUpdateMode(): boolean {
  return process.env.VISUAL_UPDATE === "1";
}

export function baselinePath(name: string): string {
  return join(BASELINE_DIR, `${name}.png`);
}

function capturedPath(name: string): string {
  return join(OUTPUT_DIR, `${name}-captured.png`);
}

function actualPath(name: string): string {
  return join(OUTPUT_DIR, `${name}-actual.png`);
}

function diffPath(name: string): string {
  return join(OUTPUT_DIR, `${name}-diff.png`);
}

export interface VisualCompareResult {
  matched: boolean;
  /** -1 when dimensions differ outright (no per-pixel diff is possible). */
  diffPixelCount: number;
  diffRatio: number;
  totalPixels: number;
}

/**
 * Compare a captured PNG on disk against the checked-in baseline for `name`.
 * On mismatch, writes output/<name>-diff.png (pixelmatch's visual diff) and
 * output/<name>-actual.png (the raw capture) for a human to inspect.
 */
export function compareAgainstBaseline(
  name: string,
  capturedPngPath: string,
): VisualCompareResult {
  const baseline = baselinePath(name);
  if (!existsSync(baseline)) {
    throw new Error(
      `No .impeccable baseline for "${name}" at ${baseline}. If this screen is new or intentionally changing, run with VISUAL_UPDATE=1 to create/update it deliberately, then review the PNG in "git diff --stat" before committing.`,
    );
  }

  const img1 = PNG.sync.read(readFileSync(baseline));
  const img2 = PNG.sync.read(readFileSync(capturedPngPath));

  if (img1.width !== img2.width || img1.height !== img2.height) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    copyFileSync(capturedPngPath, actualPath(name));
    const totalPixels = img1.width * img1.height;
    return {
      matched: false,
      diffPixelCount: -1,
      diffRatio: 1,
      totalPixels,
    };
  }

  const { width, height } = img1;
  const diff = new PNG({ width, height });
  const diffPixelCount = pixelmatch(
    img1.data,
    img2.data,
    diff.data,
    width,
    height,
    {
      threshold: PIXELMATCH_THRESHOLD,
    },
  );
  const totalPixels = width * height;
  const diffRatio = totalPixels === 0 ? 0 : diffPixelCount / totalPixels;
  const matched = diffRatio <= MAX_DIFF_RATIO;

  if (!matched) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(diffPath(name), PNG.sync.write(diff));
    copyFileSync(capturedPngPath, actualPath(name));
  }

  return { matched, diffPixelCount, diffRatio, totalPixels };
}

/** Overwrite the checked-in baseline for `name` with a fresh capture. */
export function rebaseline(name: string, capturedPngPath: string): void {
  mkdirSync(dirname(baselinePath(name)), { recursive: true });
  copyFileSync(capturedPngPath, baselinePath(name));
}

/**
 * Screenshot `page` to output/<name>-captured.png, then either rebaseline
 * (VISUAL_UPDATE=1) or pixelmatch it against .impeccable/screenshots/<name>.png
 * and fail the test past the mismatch budget. Attaches the capture (and, on
 * failure, the diff) to the Playwright test report either way.
 */
export async function captureAndVerify(
  page: Page,
  name: string,
  testInfo: TestInfo,
): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = capturedPath(name);
  await page.screenshot({ path: outPath });
  await testInfo.attach(name, { path: outPath, contentType: "image/png" });

  if (isUpdateMode()) {
    rebaseline(name, outPath);
    testInfo.annotations.push({
      type: "visual-rebaseline",
      description: `Rebaselined .impeccable/screenshots/${name}.png from this run (VISUAL_UPDATE=1). This is a deliberate change — review the PNG diff in your PR before committing it.`,
    });
    return;
  }

  const result = compareAgainstBaseline(name, outPath);
  if (!result.matched && existsSync(diffPath(name))) {
    await testInfo.attach(`${name}-diff`, {
      path: diffPath(name),
      contentType: "image/png",
    });
  }

  const pct = (result.diffRatio * 100).toFixed(2);
  expect(
    result.matched,
    result.diffPixelCount < 0
      ? `"${name}" capture dimensions do not match the .impeccable baseline ` +
          `(${result.totalPixels} px vs captured image). See output/${name}-actual.png.`
      : `"${name}" differs from the .impeccable baseline by ${pct}% of pixels ` +
          `(budget ${(MAX_DIFF_RATIO * 100).toFixed(2)}%). ` +
          `See output/${name}-diff.png and output/${name}-actual.png.`,
  ).toBe(true);
}
