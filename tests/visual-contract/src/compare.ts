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
export const MAX_DIFF_RATIO = 0.015;

/**
 * The same diff, as a share of the screen's content: every pixel that is not
 * the page background in either image. A mostly-empty screen has so few
 * content pixels that a real change (a key moved, a heading gone) hides
 * inside 1.5% of the whole frame; against its content it cannot.
 */
export const MAX_CONTENT_DIFF_RATIO = 0.05;

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
  /** Pixels that are not the page background in the baseline or the capture. */
  contentPixels: number;
  /** diffPixelCount / contentPixels (0 when there is no content at all). */
  contentDiffRatio: number;
  /** Present when dimensions match and a pixel-diff image was produced. */
  diffPng?: Buffer;
}

/**
 * Pixel-diff two PNG buffers. Used by the Playwright contract and by unit
 * tests that must not touch `.impeccable/screenshots`.
 */
export function comparePngBuffers(
  baseline: Buffer,
  captured: Buffer,
): VisualCompareResult {
  const img1 = PNG.sync.read(baseline);
  const img2 = PNG.sync.read(captured);

  if (img1.width !== img2.width || img1.height !== img2.height) {
    const totalPixels = img1.width * img1.height;
    return {
      matched: false,
      diffPixelCount: -1,
      diffRatio: 1,
      totalPixels,
      contentPixels: totalPixels,
      contentDiffRatio: 1,
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
  const contentPixels = countContentPixels(img1.data, img2.data);
  const contentDiffRatio =
    contentPixels === 0 ? 0 : diffPixelCount / contentPixels;
  const matched =
    diffRatio <= MAX_DIFF_RATIO && contentDiffRatio <= MAX_CONTENT_DIFF_RATIO;
  return {
    matched,
    diffPixelCount,
    diffRatio,
    totalPixels,
    contentPixels,
    contentDiffRatio,
    diffPng: PNG.sync.write(diff),
  };
}

/** The most common RGBA in `data` — the page background of a screenshot. */
function dominantColor(data: Uint8Array): number {
  const counts = new Map<number, number>();
  let best = 0;
  let bestCount = 0;
  for (let i = 0; i < data.length; i += 4) {
    const rgba =
      ((data[i] ?? 0) << 24) |
      ((data[i + 1] ?? 0) << 16) |
      ((data[i + 2] ?? 0) << 8) |
      (data[i + 3] ?? 0);
    const count = (counts.get(rgba) ?? 0) + 1;
    counts.set(rgba, count);
    if (count > bestCount) {
      best = rgba;
      bestCount = count;
    }
  }
  return best;
}

/** Pixels that differ from the baseline's background in either image. */
function countContentPixels(
  baseline: Uint8Array,
  captured: Uint8Array,
): number {
  const background = dominantColor(baseline);
  const at = (data: Uint8Array, i: number) =>
    ((data[i] ?? 0) << 24) |
    ((data[i + 1] ?? 0) << 16) |
    ((data[i + 2] ?? 0) << 8) |
    (data[i + 3] ?? 0);
  let content = 0;
  for (let i = 0; i < baseline.length; i += 4) {
    if (at(baseline, i) !== background || at(captured, i) !== background) {
      content += 1;
    }
  }
  return content;
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

  const result = comparePngBuffers(
    readFileSync(baseline),
    readFileSync(capturedPngPath),
  );

  if (result.diffPixelCount < 0) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    copyFileSync(capturedPngPath, actualPath(name));
    return result;
  }

  if (!result.matched) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    if (result.diffPng) {
      writeFileSync(diffPath(name), result.diffPng);
    }
    copyFileSync(capturedPngPath, actualPath(name));
  }

  return result;
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
          `(budget ${(MAX_DIFF_RATIO * 100).toFixed(2)}%) and ` +
          `${(result.contentDiffRatio * 100).toFixed(2)}% of its content ` +
          `(budget ${(MAX_CONTENT_DIFF_RATIO * 100).toFixed(2)}%). ` +
          `See output/${name}-diff.png and output/${name}-actual.png.`,
  ).toBe(true);
}
