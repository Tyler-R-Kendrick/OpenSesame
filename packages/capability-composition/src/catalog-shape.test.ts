/**
 * Descriptor shape: an unknown field and an over-long list are catalog errors
 * (carried from #470's descriptor parser).
 */
import { describe, expect, it } from "vitest";
import { MAX_DESCRIPTOR_LIST } from "./catalog-shape.js";
import { buildCatalog, validateCatalog } from "./catalog.js";
import { FIXTURE_CATALOG } from "./fixtures.js";
import type { CapabilityCatalog, CapabilityDescriptor } from "./types.js";

function codesAt(catalog: CapabilityCatalog): string[] {
  const result = validateCatalog(catalog);
  return result.ok ? [] : result.diagnostics.map((d) => `${d.code} ${d.path}`);
}

function withFirst(
  over: (d: CapabilityDescriptor) => CapabilityDescriptor,
): CapabilityCatalog {
  const [first, ...rest] = FIXTURE_CATALOG.capabilities;
  if (!first) throw new Error("fixture catalog is empty");
  return { ...FIXTURE_CATALOG, capabilities: [over(first), ...rest] };
}

describe("descriptor shape", () => {
  it("the fixture catalog is well-shaped", () => {
    expect(validateCatalog(FIXTURE_CATALOG)).toEqual({ ok: true });
  });

  it("a misspelt field is UNKNOWN_FIELD, not silently dropped", () => {
    const misspelt = withFirst((d) => ({
      ...d,
      ...{ requiresDocumentReloud: true },
    }));
    expect(codesAt(misspelt)).toContain(
      "UNKNOWN_FIELD capabilities[0].requiresDocumentReloud",
    );
  });

  it("a list past its bound is TOO_MANY_ITEMS, each field named", () => {
    const long = Array.from(
      { length: MAX_DESCRIPTOR_LIST + 1 },
      (_, i) => `pages.op-${i}`,
    );
    const [first] = FIXTURE_CATALOG.capabilities;
    if (!first) throw new Error("fixture catalog is empty");
    const { exposureDigest: _digest, ...declared } = first;
    const catalog = buildCatalog(
      [
        {
          ...declared,
          operationIds: long,
          alternatives: [{ slot: "via", oneOf: long }],
        },
      ],
      1,
    );
    const codes = codesAt(catalog);
    expect(codes).toContain("TOO_MANY_ITEMS capabilities[0].operationIds");
    expect(codes).toContain(
      "TOO_MANY_ITEMS capabilities[0].alternatives[0].oneOf",
    );
  });

  it("a list at its bound is accepted", () => {
    const atBound = withFirst((d) => ({
      ...d,
      operationIds: Array.from(
        { length: MAX_DESCRIPTOR_LIST },
        (_, i) => `pages.op-${i}`,
      ),
    }));
    expect(codesAt(atBound).filter((c) => c.startsWith("TOO_MANY"))).toEqual(
      [],
    );
  });
});
