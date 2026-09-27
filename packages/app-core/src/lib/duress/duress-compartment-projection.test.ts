import { describe, expect, it } from "vitest";
import {
  assertNoCrossCompartmentLeak,
  canRestoreLimitedCarry,
  decoyConnectorAllowed,
  projectConnectors,
  projectLimitedCarry,
  projectVisibleItems,
  resolveDecoyOrLocked,
  selectLimitedCarry,
} from "./compartment/project.js";

describe("compartment projection", () => {
  const items = [
    {
      id: "1",
      compartmentRef: "decoy",
      title: "Bank",
      sensitive: false,
      folder: "daily",
      hasTotp: true,
    },
    {
      id: "2",
      compartmentRef: "real",
      title: "Root key",
      sensitive: true,
      folder: "secrets",
      hasPasskey: true,
    },
  ];

  it("scopes search/counts and never falls back to real vault on corrupt decoy", () => {
    const visible = projectVisibleItems(items, ["decoy"], "decoy", {
      search: "bank",
    });
    expect(visible.map((i) => i.id)).toEqual(["1"]);
    assertNoCrossCompartmentLeak(visible, ["decoy"]);
    expect(resolveDecoyOrLocked(false, false)).toBe("locked");
    expect(resolveDecoyOrLocked(true, true)).toBe("locked");
    expect(decoyConnectorAllowed("decoy", false)).toBe(false);
    expect(projectConnectors(["c1", "c2"], "decoy", new Set(["c2"]))).toEqual([
      "c2",
    ]);
  });

  it("limited-carry requires separate restore context", () => {
    const selection = selectLimitedCarry(items, ["1"], "restore-ctx");
    expect(projectLimitedCarry(items, selection, "restricted")).toHaveLength(1);
    expect(canRestoreLimitedCarry(selection, "restore-ctx")).toBe(false);
    expect(canRestoreLimitedCarry(selection, "active-ctx")).toBe(true);
  });
});
