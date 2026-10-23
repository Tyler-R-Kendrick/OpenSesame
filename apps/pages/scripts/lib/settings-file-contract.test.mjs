import { describe, expect, it } from "vitest";
import { viewerChecks } from "./settings-file-contract.mjs";

function measurement() {
  return {
    narrow: true,
    coarse: true,
    vw: 390,
    docWidth: 390,
    list: { l: 12, t: 80, r: 378, b: 170, w: 366 },
    file: { l: 12, t: 180, r: 378, b: 600, w: 366 },
    rows: [{ name: "secret.json", h: 44 }],
    stage: { overflowX: "auto", scrollWidth: 600, clientWidth: 366 },
    paintSize: 16,
    inputSize: 16,
    paintBox: { l: 12, t: 180, w: 366 },
    inputBox: { l: 12, t: 180, w: 366 },
  };
}
function observations() {
  const checks = [];
  return {
    checks,
    harness: { setStep() {}, check: (ok, label) => checks.push({ ok, label }) },
  };
}

describe("settings file viewer geometry contract", () => {
  it.each([null, undefined])(
    "records a missing file list as a failed contract instead of throwing (%s)",
    (list) => {
      const { harness, checks } = observations();
      viewerChecks(harness, "missing", { ...measurement(), list });
      expect(checks).toContainEqual({
        ok: false,
        label: "missing: the file list and the open file are both drawn",
      });
      expect(checks).toHaveLength(5);
    },
  );

  it("still rejects a drawn list beside the file on a narrow screen", () => {
    const { harness, checks } = observations();
    const m = measurement();
    m.list = { ...m.list, b: 220 };
    viewerChecks(harness, "stacking", m);
    expect(checks.filter((check) => !check.ok)).toEqual([
      expect.objectContaining({ label: expect.stringContaining("one column") }),
    ]);
  });

  it("accepts the actual touch floors and stacked file layout", () => {
    const { harness, checks } = observations();
    viewerChecks(harness, "stacked", measurement());
    expect(checks).toHaveLength(7);
    expect(checks.every((check) => check.ok === true)).toBe(true);
  });
});
