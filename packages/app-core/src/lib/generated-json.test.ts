import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { renderPlanJson } from "../../scripts/emit-connect-presets.mjs";
import { packJsonRows } from "../../scripts/pack-json.mjs";
import { CONNECT_PLAN_JSON } from "./connect-presets.generated.js";
import { unpackGeneratedJson } from "./generated-json.js";
import { NATIVE_BROWSER_POLICY_JSON } from "./native-browser-policy.generated.js";

it("reconstructs every original connector plan byte for byte, including provider endpoints and instructions", () => {
  const originals = renderPlanJson();
  const packed = packJsonRows(originals);
  const decoded = packed.rows.map((row) =>
    unpackGeneratedJson(row, packed.dictionary),
  );
  expect(decoded).toEqual(originals);
  expect(CONNECT_PLAN_JSON).toEqual(originals);
  expect(originals).toHaveLength(194);
});

it("reconstructs the complete authored browser policy with every recorded probe unchanged", () => {
  const original = JSON.stringify(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../spec/connectors/browser-policy.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  const packed = packJsonRows([original]);
  expect(
    packed.rows.map((row) => unpackGeneratedJson(row, packed.dictionary)),
  ).toEqual([original]);
  expect(NATIVE_BROWSER_POLICY_JSON).toBe(original);
});

it("preserves escaped strings, Unicode, nulls, numbers and row order", () => {
  const rows = [
    JSON.stringify({
      description: 'Provider\'s "quoted" guide\n雪',
      endpoint: "https://provider.example/api",
      count: 2,
      optional: null,
    }),
    JSON.stringify({
      description: 'Provider\'s "quoted" guide\n雪',
      endpoint: "https://provider.example/api",
      count: 3,
      optional: false,
    }),
  ];
  const packed = packJsonRows(rows);
  expect(
    packed.rows.map((row) => unpackGeneratedJson(row, packed.dictionary)),
  ).toEqual(rows);
  expect(packJsonRows(rows)).toEqual(packed);
});

it("fails generation when public source text could be mistaken for an encoded fragment", () => {
  expect(() =>
    packJsonRows([JSON.stringify({ instructions: "Literal ~af~ marker" })]),
  ).toThrow("reserved");
});

it("rejects missing fragments and does not reinterpret decoded public content", () => {
  expect(() => unpackGeneratedJson("~a~", [])).toThrow(
    "Invalid generated JSON",
  );
  expect(unpackGeneratedJson("~0~", ["~1~", "null"])).toBe("~1~");
});
