import { describe, expect, it } from "vitest";
import {
  isCapabilityId,
  isModuleId,
  isOpaqueId,
  moduleCapability,
  sortIds,
} from "./ids.js";

describe("identifier syntax", () => {
  it("accepts well-formed capability ids and rejects the rest", () => {
    expect(isCapabilityId("vault.passwords")).toBe(true);
    expect(isCapabilityId("enterprise.ca-administration")).toBe(true);
    expect(isCapabilityId("a.b.c-d")).toBe(true);
    expect(isCapabilityId("Vault.passwords")).toBe(false);
    expect(isCapabilityId("vault")).toBe(false);
    expect(isCapabilityId("vault.")).toBe(false);
    expect(isCapabilityId("vault.-x")).toBe(false);
    expect(isCapabilityId("vault..x")).toBe(false);
    expect(isCapabilityId(`v.${"a".repeat(63)}`)).toBe(false);
  });

  it("accepts module ids of the form <capability>/<unit>", () => {
    expect(isModuleId("connectors.external/section")).toBe(true);
    expect(isModuleId("agents.webmcp/runtime")).toBe(true);
    expect(isModuleId("agents.webmcp")).toBe(false);
    expect(isModuleId("agents.webmcp/")).toBe(false);
    expect(isModuleId("agents.webmcp/Runtime")).toBe(false);
    expect(isModuleId("/runtime")).toBe(false);
    expect(moduleCapability("agents.webmcp/runtime")).toBe("agents.webmcp");
    expect(moduleCapability("nope")).toBeNull();
  });

  it("bounds opaque ids to 1–128 characters of [A-Za-z0-9._:-]", () => {
    expect(isOpaqueId("inst_01:abc.def-x")).toBe(true);
    expect(isOpaqueId("inst/01")).toBe(false);
    expect(isOpaqueId("")).toBe(false);
    expect(isOpaqueId("a".repeat(128))).toBe(true);
    expect(isOpaqueId("a".repeat(129))).toBe(false);
    expect(isOpaqueId("has space")).toBe(false);
  });

  it("sorts ids uniquely and locale-free", () => {
    expect(sortIds(["b.x", "a.y", "b.x", "a.b"])).toEqual(["a.b", "a.y", "b.x"]);
  });
});
