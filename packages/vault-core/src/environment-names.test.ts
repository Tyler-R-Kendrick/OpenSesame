/** Environment naming, ordering and own-property boundaries (ADR 0194). */
import { describe, expect, it } from "vitest";
import {
  type VaultEnvironments,
  cellOf,
  environmentNames,
  isEnvironmentName,
  normalizeEnvironmentName,
} from "./environments.js";

describe("environment names", () => {
  it("lower-cases, joins words and keeps what a parser can read unquoted", () => {
    expect(normalizeEnvironmentName("  Production ")).toBe("production");
    expect(normalizeEnvironmentName("prod EU")).toBe("prod-eu");
    expect(normalizeEnvironmentName("v1.2_rc")).toBe("v1.2_rc");
  });

  it.each(["", "   ", "-lead", "has/slash", "a(b)", "x".repeat(33), "é"])(
    "refuses %j",
    (raw) => {
      expect(normalizeEnvironmentName(raw)).toBeNull();
    },
  );

  it("lists live names oldest first, a removed one gone and a bad key never trusted", () => {
    const environments: VaultEnvironments = {
      production: { at: "2026-01-03T00:00:00.000Z" },
      development: { at: "2026-01-01T00:00:00.000Z" },
      staging: { at: "2026-01-02T00:00:00.000Z" },
      old: { at: "2026-01-01T12:00:00.000Z", removed: true },
      "../etc": { at: "2026-01-01T00:00:00.000Z" },
    };
    expect(environmentNames(environments)).toEqual([
      "development",
      "staging",
      "production",
    ]);
    expect(isEnvironmentName("../etc")).toBe(false);
    expect(environmentNames(undefined)).toEqual([]);
  });

  it("never reads an inherited property as a cell", () => {
    expect(cellOf({ staging: { value: "x" } }, "constructor")).toBeUndefined();
    expect(cellOf(undefined, "staging")).toBeUndefined();
    expect(cellOf({ staging: { value: "x" } }, "staging")).toEqual({
      value: "x",
    });
  });
});
