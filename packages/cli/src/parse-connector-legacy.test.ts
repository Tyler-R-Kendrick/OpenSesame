import { expect, it } from "vitest";
import { parseArgs } from "./parse.js";

it("parses human-only legacy connector review and explicitly selected resolution", () => {
  expect(
    parseArgs([
      "security",
      "connectors",
      "legacy-discard-all",
      "--acknowledge-irrecoverable-legacy-discard",
    ]),
  ).toMatchObject({ name: "security-connectors-legacy-discard-all" });
  expect(
    parseArgs(["security", "connectors", "legacy-status", "--json"]),
  ).toMatchObject({ name: "security-connectors-legacy-status" });
  for (const decision of ["import", "discard"] as const)
    expect(
      parseArgs([
        "security",
        "connectors",
        `legacy-${decision}`,
        "device_a",
        "device_b",
        "--acknowledge-ownership-ambiguity",
      ]),
    ).toMatchObject({
      name: "security-connectors-legacy-resolve",
      decision,
      connectionIds: ["device_a", "device_b"],
    });
});

it.each([
  ["legacy-discard-all"],
  ["legacy-discard-all", "--acknowledge-ownership-ambiguity"],
  [
    "legacy-discard-all",
    "device_a",
    "--acknowledge-irrecoverable-legacy-discard",
  ],
  ["legacy-status", "device_a"],
  ["legacy-import", "device_a"],
  ["legacy-discard", "--acknowledge-ownership-ambiguity"],
  [
    "legacy-import",
    "device_a",
    "device_a",
    "--acknowledge-ownership-ambiguity",
  ],
  [
    "legacy-import",
    "--password",
    "fixture",
    "--acknowledge-ownership-ambiguity",
  ],
  [
    "legacy-discard",
    ...Array.from({ length: 17 }, (_, i) => `device_${i}`),
    "--acknowledge-ownership-ambiguity",
  ],
])("refuses unconfirmed, secret-bearing or unbounded grammar %j", (...args) => {
  expect(() => parseArgs(["security", "connectors", ...args])).toThrow();
});
