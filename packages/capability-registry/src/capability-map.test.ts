import { describe, expect, it } from "vitest";
import {
  OPERATION_CAPABILITY,
  capabilitiesWithOperations,
  operationsForCapabilities,
} from "./capability-map.js";
import { CAPABILITIES } from "./index.js";

/** Mirrors `isCapabilityId` in @opensesame/capability-composition (kept pure here). */
const CAPABILITY_ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;

const surfaced = CAPABILITIES.filter(
  (capability) =>
    capability.surfaces.pwa !== null || capability.surfaces.webmcp !== null,
);

describe("operation → product capability map", () => {
  it("covers every registry operation with a pwa or webmcp surface", () => {
    const missing = surfaced
      .map((capability) => capability.id)
      .filter((id) => !(id in OPERATION_CAPABILITY));
    expect(missing).toEqual([]);
  });

  it("names no operation the registry does not have", () => {
    const known = new Set(CAPABILITIES.map((capability) => capability.id));
    const unknown = Object.keys(OPERATION_CAPABILITY).filter(
      (id) => !known.has(id),
    );
    expect(unknown).toEqual([]);
  });

  it("maps only operations that actually reach a pwa or webmcp surface", () => {
    const surfacedIds = new Set(surfaced.map((capability) => capability.id));
    const stray = Object.keys(OPERATION_CAPABILITY).filter(
      (id) => !surfacedIds.has(id),
    );
    expect(stray).toEqual([]);
  });

  it("every value is a syntactically valid product capability id", () => {
    for (const [operation, capability] of Object.entries(
      OPERATION_CAPABILITY,
    )) {
      expect(capability, `${operation} → ${capability}`).toMatch(
        CAPABILITY_ID,
      );
      expect(capability.length).toBeLessThanOrEqual(64);
    }
  });

  it("is frozen data", () => {
    expect(Object.isFrozen(OPERATION_CAPABILITY)).toBe(true);
  });
});

describe("operationsForCapabilities", () => {
  it("returns the sorted operations owned by the given capabilities", () => {
    const ops = operationsForCapabilities(["wallet.spending"]);
    expect(ops).toEqual([...ops].sort());
    expect(ops).toContain("wallet.payment.propose");
    expect(ops.every((op) => op.startsWith("wallet."))).toBe(true);
  });

  it("never widens for unknown ids", () => {
    expect(operationsForCapabilities(["nope.nothing"])).toEqual([]);
    expect(operationsForCapabilities([])).toEqual([]);
  });

  it("partitions the map: the union over all owners is the whole key set", () => {
    const all = operationsForCapabilities(capabilitiesWithOperations());
    expect(all).toEqual(Object.keys(OPERATION_CAPABILITY).sort());
  });
});
