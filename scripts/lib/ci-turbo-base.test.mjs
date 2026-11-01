import { describe, expect, it } from "vitest";
import { turboComparisonRef } from "./ci-turbo-base.mjs";

const sha = (n) => n.toString(16).padStart(40, "0");

describe("turboComparisonRef", () => {
  it("uses merge_group base sha when present", () => {
    expect(
      turboComparisonRef({
        GITHUB_EVENT_NAME: "merge_group",
        BASE_SHA: sha(1),
      }),
    ).toBe(sha(1));
  });

  it("uses origin/base ref for pull requests", () => {
    expect(
      turboComparisonRef({
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_BASE_REF: "main",
      }),
    ).toBe("origin/main");
    expect(
      turboComparisonRef({
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_BASE_REF: "cursor/parent-8e4a",
      }),
    ).toBe("origin/cursor/parent-8e4a");
  });

  it("defaults to origin/main for push and dispatch", () => {
    for (const event of ["push", "workflow_dispatch"]) {
      expect(turboComparisonRef({ GITHUB_EVENT_NAME: event })).toBe(
        "origin/main",
      );
    }
  });
});
