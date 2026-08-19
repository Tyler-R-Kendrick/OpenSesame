import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASELINE_DIR,
  MAX_DIFF_RATIO,
  OUTPUT_DIR,
  baselinePath,
  captureAndVerify,
  compareAgainstBaseline,
  comparePngBuffers,
  rebaseline,
} from "./compare.js";

function solidPng(width: number, height: number, fill: number): Buffer {
  const img = new PNG({ width, height });
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = fill;
    img.data[i + 1] = fill;
    img.data[i + 2] = fill;
    img.data[i + 3] = 255;
  }
  return PNG.sync.write(img);
}

/** Baseline names unique to this run so concurrent work never collides. */
const RUN_ID = `unit-test-${process.pid}-${Date.now()}`;

const createdBaselines: string[] = [];
const createdOutputs: string[] = [];

function baselineName(suffix: string): string {
  return `${RUN_ID}-${suffix}`;
}

function makeBaseline(name: string, png: Buffer): string {
  const path = baselinePath(name);
  mkdirSync(BASELINE_DIR, { recursive: true });
  writeFileSync(path, png);
  createdBaselines.push(path);
  return path;
}

function makeCaptured(name: string, png: Buffer): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const path = join(OUTPUT_DIR, `${name}-captured.png`);
  writeFileSync(path, png);
  createdOutputs.push(path);
  return path;
}

function outputPath(name: string, kind: "actual" | "diff"): string {
  return join(OUTPUT_DIR, `${name}-${kind}.png`);
}

afterEach(() => {
  for (const path of createdBaselines.splice(0)) {
    rmSync(path, { force: true });
  }
  for (const path of createdOutputs.splice(0)) {
    rmSync(path, { force: true });
  }
});

interface FakeHarness {
  page: Page;
  testInfo: TestInfo;
  attachments: Array<{ name: string; path: string }>;
}

/** Minimal Page/TestInfo doubles: screenshot writes a real PNG to disk. */
function fakeHarness(png: Buffer): FakeHarness {
  const attachments: Array<{ name: string; path: string }> = [];
  const page = {
    screenshot: async ({ path }: { path: string }) => {
      writeFileSync(path, png);
      createdOutputs.push(path);
      return png;
    },
  } as unknown as Page;
  const testInfo = {
    annotations: [] as Array<{ type: string; description?: string }>,
    attach: async (name: string, options: { path: string }) => {
      attachments.push({ name, path: options.path });
    },
  } as unknown as TestInfo;
  return { page, testInfo, attachments };
}

describe("visual-contract compare unit", () => {
  describe("baselinePath", () => {
    it("resolves names into .impeccable/screenshots", () => {
      expect(baselinePath("home")).toBe(join(BASELINE_DIR, "home.png"));
    });
  });

  describe("compareAgainstBaseline", () => {
    it("throws with remediation guidance when no baseline exists", () => {
      const name = baselineName("missing");
      const captured = makeCaptured(name, solidPng(4, 4, 10));
      expect(() => compareAgainstBaseline(name, captured)).toThrow(
        /No \.impeccable baseline.*VISUAL_UPDATE=1/s,
      );
    });

    it("matches an identical capture and writes no inspection artifacts", () => {
      const name = baselineName("match");
      const png = solidPng(8, 8, 64);
      makeBaseline(name, png);
      const captured = makeCaptured(name, png);

      const result = compareAgainstBaseline(name, captured);

      expect(result.matched).toBe(true);
      expect(result.diffPixelCount).toBe(0);
      expect(existsSync(outputPath(name, "actual"))).toBe(false);
      expect(existsSync(outputPath(name, "diff"))).toBe(false);
    });

    it("dimension mismatch copies the raw capture but produces no diff PNG", () => {
      const name = baselineName("dims");
      makeBaseline(name, solidPng(8, 8, 32));
      const capturedPng = solidPng(4, 4, 32);
      const captured = makeCaptured(name, capturedPng);

      const result = compareAgainstBaseline(name, captured);

      expect(result.matched).toBe(false);
      expect(result.diffPixelCount).toBe(-1);
      expect(result.diffPng).toBeUndefined();
      const actual = outputPath(name, "actual");
      createdOutputs.push(actual);
      expect(readFileSync(actual)).toEqual(capturedPng);
      expect(existsSync(outputPath(name, "diff"))).toBe(false);
    });

    it("past-budget pixel drift writes both a diff PNG and the actual capture", () => {
      const name = baselineName("drift");
      makeBaseline(name, solidPng(8, 8, 0));
      const capturedPng = solidPng(8, 8, 255);
      const captured = makeCaptured(name, capturedPng);

      const result = compareAgainstBaseline(name, captured);

      expect(result.matched).toBe(false);
      expect(result.diffRatio).toBeGreaterThan(MAX_DIFF_RATIO);
      const diff = outputPath(name, "diff");
      const actual = outputPath(name, "actual");
      createdOutputs.push(diff, actual);
      // The written diff round-trips as a PNG of the original dimensions.
      const diffImg = PNG.sync.read(readFileSync(diff));
      expect(diffImg.width).toBe(8);
      expect(diffImg.height).toBe(8);
      expect(readFileSync(actual)).toEqual(capturedPng);
    });

    it("within-budget drift still matches", () => {
      const name = baselineName("tolerant");
      // Flip 1 pixel of 64 (1.56% > 1.5% would fail; use a larger canvas so
      // a single flipped pixel stays under the budget).
      const width = 16;
      const height = 16;
      const baselineImg = new PNG({ width, height });
      baselineImg.data.fill(255);
      const capturedImg = new PNG({ width, height });
      capturedImg.data.fill(255);
      capturedImg.data[0] = 0;
      capturedImg.data[1] = 0;
      capturedImg.data[2] = 0;
      const baseline = PNG.sync.write(baselineImg);
      const capturedPng = PNG.sync.write(capturedImg);
      makeBaseline(name, baseline);
      const captured = makeCaptured(name, capturedPng);

      const result = compareAgainstBaseline(name, captured);

      expect(result.diffPixelCount).toBeGreaterThanOrEqual(0);
      expect(result.diffRatio).toBeLessThanOrEqual(MAX_DIFF_RATIO);
      expect(result.matched).toBe(true);
    });
  });

  describe("rebaseline", () => {
    it("copies the capture over the checked-in baseline path", () => {
      const name = baselineName("rebaseline");
      const png = solidPng(4, 4, 99);
      const captured = makeCaptured(name, png);
      createdBaselines.push(baselinePath(name));

      rebaseline(name, captured);

      expect(readFileSync(baselinePath(name))).toEqual(png);
    });
  });

  describe("captureAndVerify", () => {
    it("attaches the capture and passes when the screenshot matches", async () => {
      const name = baselineName("verify-ok");
      const png = solidPng(8, 8, 128);
      makeBaseline(name, png);
      const { page, testInfo, attachments } = fakeHarness(png);

      await captureAndVerify(page, name, testInfo);

      expect(attachments).toEqual([
        { name, path: join(OUTPUT_DIR, `${name}-captured.png`) },
      ]);
      expect(
        (testInfo.annotations as Array<{ type: string }>).some(
          (a) => a.type === "visual-rebaseline",
        ),
      ).toBe(false);
    });

    it("VISUAL_UPDATE=1 rebaselines instead of comparing and annotates the run", async () => {
      const name = baselineName("verify-update");
      const png = solidPng(4, 4, 7);
      const { page, testInfo } = fakeHarness(png);
      createdBaselines.push(baselinePath(name));
      const previous = process.env.VISUAL_UPDATE;
      process.env.VISUAL_UPDATE = "1";
      try {
        await captureAndVerify(page, name, testInfo);
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(process.env, "VISUAL_UPDATE");
        } else {
          process.env.VISUAL_UPDATE = previous;
        }
      }

      expect(readFileSync(baselinePath(name))).toEqual(png);
      const annotations = testInfo.annotations as Array<{
        type: string;
        description?: string;
      }>;
      expect(annotations).toHaveLength(1);
      const annotation = annotations[0];
      expect(annotation?.type).toBe("visual-rebaseline");
      expect(annotation?.description).toContain(`${name}.png`);
    });

    it("fails the test and attaches the diff when drift exceeds the budget", async () => {
      const name = baselineName("verify-drift");
      makeBaseline(name, solidPng(8, 8, 0));
      const { page, testInfo, attachments } = fakeHarness(solidPng(8, 8, 255));

      // @playwright/test's expect fails the contract with an assertion error.
      await expect(
        captureAndVerify(page, name, testInfo),
      ).rejects.toThrowError();

      const diff = outputPath(name, "diff");
      createdOutputs.push(diff, outputPath(name, "actual"));
      expect(attachments.map((a) => a.name)).toEqual([name, `${name}-diff`]);
      expect(attachments[1]?.path).toBe(diff);
    });

    it("reports a dimension mismatch without attaching a diff", async () => {
      const name = baselineName("verify-dims");
      makeBaseline(name, solidPng(8, 8, 32));
      const { page, testInfo, attachments } = fakeHarness(solidPng(4, 4, 32));

      await expect(
        captureAndVerify(page, name, testInfo),
      ).rejects.toThrowError();

      createdOutputs.push(outputPath(name, "actual"));
      expect(attachments.map((a) => a.name)).toEqual([name]);
      expect(existsSync(outputPath(name, "diff"))).toBe(false);
    });

    it("propagates the missing-baseline error before any assertion", async () => {
      const name = baselineName("verify-missing");
      const { page, testInfo, attachments } = fakeHarness(solidPng(4, 4, 1));

      await expect(captureAndVerify(page, name, testInfo)).rejects.toThrow(
        /No \.impeccable baseline/,
      );
      // The capture itself is still attached for debugging.
      expect(attachments.map((a) => a.name)).toEqual([name]);
    });
  });

  describe("comparePngBuffers (edge cases)", () => {
    it("exposes a diff PNG whose dimensions match the inputs", () => {
      const a = solidPng(6, 3, 10);
      const b = solidPng(6, 3, 200);
      const result = comparePngBuffers(a, b);
      expect(result.diffPng).toBeDefined();
      const diff = PNG.sync.read(result.diffPng as Buffer);
      expect(diff.width).toBe(6);
      expect(diff.height).toBe(3);
      expect(result.totalPixels).toBe(18);
    });

    it("treats width-only mismatches as dimension failures", () => {
      const result = comparePngBuffers(solidPng(8, 8, 1), solidPng(4, 8, 1));
      expect(result.matched).toBe(false);
      expect(result.diffPixelCount).toBe(-1);
      expect(result.totalPixels).toBe(64);
    });

    it("rejects corrupt PNG buffers instead of returning a bogus result", () => {
      const valid = solidPng(4, 4, 1);
      const garbage = Buffer.from("not a png at all");
      expect(() => comparePngBuffers(valid, garbage)).toThrow();
    });
  });
});
