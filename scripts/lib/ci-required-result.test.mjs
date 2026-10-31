import { describe, expect, it } from "vitest";
import {
  assertCompleteResults,
  assertSelectedResult,
} from "./ci-required-result.mjs";

const admitted = {
  draft: "false",
  preflight: "success",
  selected: "true",
  result: "success",
};

describe("required integration results", () => {
  it("accepts an executed selected suite and an explicitly unselected suite", () => {
    expect(() => assertSelectedResult(admitted)).not.toThrow();
    expect(() =>
      assertSelectedResult({
        ...admitted,
        selected: "false",
        result: "skipped",
      }),
    ).not.toThrow();
  });
  it.each(["failure", "cancelled", "skipped", "", undefined])(
    "rejects selected result %s",
    (result) => {
      expect(() => assertSelectedResult({ ...admitted, result })).toThrow();
    },
  );
  it.each(["failure", "cancelled", "skipped", "", undefined])(
    "never turns failed classification %s into a skip success",
    (preflight) => {
      expect(() =>
        assertSelectedResult({
          ...admitted,
          preflight,
          selected: "false",
          result: "skipped",
        }),
      ).toThrow();
    },
  );
  it.each(["true", "", undefined])(
    "rejects draft or absent admission %s even with green suites",
    (draft) => {
      expect(() => assertSelectedResult({ ...admitted, draft })).toThrow();
    },
  );
  it.each(["", "yes", undefined])(
    "rejects missing or malformed area selection %s",
    (selected) => {
      expect(() =>
        assertSelectedResult({ ...admitted, selected, result: "skipped" }),
      ).toThrow();
    },
  );
});

describe("complete qualification", () => {
  it("requires all matrices, auxiliary checks and admission to succeed", () => {
    const needs = {
      admission: { result: "success" },
      browser: { result: "success" },
      native: { result: "success" },
    };
    expect(() => assertCompleteResults(needs)).not.toThrow();
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      expect(() =>
        assertCompleteResults({ ...needs, native: { result } }),
      ).toThrow();
    }
  });
  it.each([null, [], {}, { native: {} }])(
    "cannot produce green qualification with absent work",
    (needs) => {
      expect(() => assertCompleteResults(needs)).toThrow();
    },
  );
});
