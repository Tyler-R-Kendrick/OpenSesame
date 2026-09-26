import { describe, expect, it } from "vitest";
import {
  aggregateDiagnostics,
  compareLedger,
  ledgerFromCounts,
  serializeLedger,
  tightenLedger,
} from "./anti-slop-ledger.mjs";

const TYPEOF = "anti-slop/no-runtime-typeof";
const SAFETY = "anti-slop/require-safety-comment-for-type-assertion";

/** file -> rule -> count, as the gate measures it. */
const measured = (files) =>
  new Map(
    Object.entries(files).map(([file, rules]) => [
      file,
      new Map(Object.entries(rules)),
    ]),
  );

describe("aggregateDiagnostics", () => {
  it("counts findings per file and rule, and sets directives and unknowns apart", () => {
    const finding = (filename, rule, line) => ({
      message: "…",
      code: `anti-slop(${rule})`,
      severity: "error",
      filename,
      labels: [{ span: { line } }],
    });
    const { counts, unusedDirectives, unrecognized } = aggregateDiagnostics([
      finding("./a.ts", "no-runtime-typeof", 1),
      finding("a.ts", "no-runtime-typeof", 9),
      finding("a.ts", "require-safety-comment-for-type-assertion", 4),
      {
        message: "Unused eslint-disable directive (no problems were reported).",
        severity: "error",
        filename: "b.mjs",
        labels: [{ span: { line: 15 } }],
      },
      { message: "Expected `,`", severity: "error", filename: "c.ts" },
    ]);
    expect(ledgerFromCounts(counts)).toEqual({
      "a.ts": { [TYPEOF]: 2, [SAFETY]: 1 },
    });
    expect(unusedDirectives).toEqual(["b.mjs:15"]);
    expect(unrecognized).toEqual(["c.ts: Expected `,`"]);
  });
});

describe("compareLedger", () => {
  it("passes a tree that matches its ledger", () => {
    expect(
      compareLedger(measured({ "a.ts": { [TYPEOF]: 2 } }), {
        "a.ts": { [TYPEOF]: 2 },
      }),
    ).toEqual({ regressions: [], improvements: [] });
  });

  it("fails a count above its recorded number", () => {
    const { regressions } = compareLedger(
      measured({ "a.ts": { [TYPEOF]: 3 } }),
      { "a.ts": { [TYPEOF]: 2 } },
    );
    expect(regressions).toEqual([
      { file: "a.ts", rule: TYPEOF, allowed: 2, count: 3, kind: "increase" },
    ]);
  });

  it("fails a file the ledger does not name", () => {
    const { regressions } = compareLedger(
      measured({ "new.ts": { [TYPEOF]: 1 } }),
      {},
    );
    expect(regressions).toEqual([
      { file: "new.ts", rule: TYPEOF, allowed: 0, count: 1, kind: "new-file" },
    ]);
  });

  it("fails a rule the ledger does not name for a recorded file", () => {
    const { regressions } = compareLedger(
      measured({ "a.ts": { [TYPEOF]: 1, [SAFETY]: 1 } }),
      { "a.ts": { [TYPEOF]: 1 } },
    );
    expect(regressions).toEqual([
      { file: "a.ts", rule: SAFETY, allowed: 0, count: 1, kind: "new-rule" },
    ]);
  });

  it("reports a decrease the ledger has not recorded", () => {
    const { regressions, improvements } = compareLedger(
      measured({ "a.ts": { [TYPEOF]: 1 } }),
      { "a.ts": { [TYPEOF]: 2 } },
    );
    expect(regressions).toEqual([]);
    expect(improvements).toEqual([
      { file: "a.ts", rule: TYPEOF, allowed: 2, count: 1 },
    ]);
  });

  it("reports a deleted or cleaned file as an improvement to record", () => {
    const { improvements } = compareLedger(measured({}), {
      "gone.ts": { [TYPEOF]: 1 },
    });
    expect(improvements).toEqual([
      { file: "gone.ts", rule: TYPEOF, allowed: 1, count: 0 },
    ]);
  });
});

describe("tightenLedger (--update)", () => {
  it("lowers counts and drops entries that reach zero", () => {
    const { files } = tightenLedger(measured({ "a.ts": { [TYPEOF]: 1 } }), {
      "a.ts": { [TYPEOF]: 3, [SAFETY]: 2 },
    });
    expect(files).toEqual({ "a.ts": { [TYPEOF]: 1 } });
  });

  it("drops a deleted file", () => {
    const { files } = tightenLedger(measured({ "a.ts": { [TYPEOF]: 1 } }), {
      "a.ts": { [TYPEOF]: 1 },
      "gone.ts": { [SAFETY]: 4 },
    });
    expect(files).toEqual({ "a.ts": { [TYPEOF]: 1 } });
  });

  it("refuses to raise a count", () => {
    const result = tightenLedger(measured({ "a.ts": { [TYPEOF]: 2 } }), {
      "a.ts": { [TYPEOF]: 1 },
    });
    expect(result.files).toBeUndefined();
    expect(result.refused).toEqual([
      { file: "a.ts", rule: TYPEOF, allowed: 1, count: 2, kind: "increase" },
    ]);
  });

  it("refuses to add an entry", () => {
    const result = tightenLedger(measured({ "new.ts": { [TYPEOF]: 1 } }), {
      "a.ts": { [TYPEOF]: 3 },
    });
    expect(result.files).toBeUndefined();
    expect(result.refused.map((r) => r.kind)).toEqual(["new-file"]);
  });
});

describe("serializeLedger", () => {
  it("totals files, violations and each rule", () => {
    const ledger = serializeLedger({
      "a.ts": { [SAFETY]: 1, [TYPEOF]: 2 },
      "b.ts": { [TYPEOF]: 1 },
    });
    expect(ledger.totals).toEqual({
      files: 2,
      violations: 4,
      byRule: { [SAFETY]: 1, [TYPEOF]: 3 },
    });
    expect(Object.keys(ledger.files)).toEqual(["a.ts", "b.ts"]);
  });
});
