/**
 * A gate run leaves the committed review captures alone; only an explicit
 * refresh writes them.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reviewCaptureDir } from "./review-captures.mjs";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));

describe("reviewCaptureDir", () => {
  it("writes to the gitignored artifacts directory by default", () => {
    expect(reviewCaptureDir({})).toBe(`${repo}artifacts/impeccable-review/`);
  });

  it("writes the committed review set only when asked to refresh it", () => {
    expect(reviewCaptureDir({ UPDATE_REVIEW_CAPTURES: "1" })).toBe(
      `${repo}apps/pages/.impeccable/review/`,
    );
    expect(reviewCaptureDir({ UPDATE_REVIEW_CAPTURES: "0" })).toBe(
      `${repo}artifacts/impeccable-review/`,
    );
  });
});
