import { describe, expect, it } from "vitest";
import { buildCatalog, validateCatalog } from "./catalog.js";
import { FIXTURE_CATALOG } from "./fixtures.js";
import type { CapabilityDescriptor } from "./types.js";

type Declared = Omit<CapabilityDescriptor, "exposureDigest">;

function cap(id: string, overrides: Partial<Declared> = {}): Declared {
  return {
    id,
    descriptorVersion: 1,
    tier: "optional",
    title: id,
    summary: "",
    dependencies: [],
    alternatives: [],
    operationIds: [],
    moduleIds: [`${id}/runtime`],
    environments: ["document"],
    egress: [],
    browserPermissions: [],
    keyAccess: "none",
    requiresService: false,
    offlineLimits: "",
    workerGraphConstraint: null,
    requiresDocumentReload: false,
    itemKinds: [],
    ...overrides,
  };
}

function codesOf(result: ReturnType<typeof validateCatalog>): string[] {
  return result.ok ? [] : result.diagnostics.map((d) => d.code);
}

describe("validateCatalog", () => {
  it("accepts the fixture catalog", () => {
    expect(validateCatalog(FIXTURE_CATALOG)).toEqual({ ok: true });
  });

  it("MODEL-06: rejects an unknown dependency", () => {
    const c = buildCatalog([cap("a.b", { dependencies: ["a.missing"] })], 1);
    expect(codesOf(validateCatalog(c))).toContain("UNKNOWN_CAPABILITY");
  });

  it("MODEL-06: rejects a dependency cycle, including through an alternative", () => {
    const direct = buildCatalog(
      [
        cap("a.b", { dependencies: ["a.c"] }),
        cap("a.c", { dependencies: ["a.b"] }),
      ],
      1,
    );
    expect(codesOf(validateCatalog(direct))).toContain("DEPENDENCY_CYCLE");
    const viaSlot = buildCatalog(
      [
        cap("a.b", { alternatives: [{ slot: "t", oneOf: ["a.c"] }] }),
        cap("a.c", { dependencies: ["a.b"] }),
      ],
      1,
    );
    expect(codesOf(validateCatalog(viaSlot))).toContain("DEPENDENCY_CYCLE");
    expect(
      codesOf(
        validateCatalog(
          buildCatalog([cap("a.b", { dependencies: ["a.b"] })], 1),
        ),
      ),
    ).toContain("DEPENDENCY_CYCLE");
  });

  it("MODEL-06: rejects a dependency chain deeper than 16 and accepts one of 16", () => {
    const chain = (n: number): Declared[] =>
      Array.from({ length: n + 1 }, (_, i) =>
        cap(`a.c${i}`, { dependencies: i === 0 ? [] : [`a.c${i - 1}`] }),
      );
    expect(validateCatalog(buildCatalog(chain(16), 1))).toEqual({ ok: true });
    expect(codesOf(validateCatalog(buildCatalog(chain(17), 1)))).toContain(
      "DEPENDENCY_DEPTH",
    );
  });

  it("MODEL-06: rejects a duplicate id, an oversized catalog, and a bad module prefix boundedly", () => {
    expect(
      codesOf(validateCatalog(buildCatalog([cap("a.b"), cap("a.b")], 1))),
    ).toContain("DUPLICATE_ID");
    const many = buildCatalog(
      Array.from({ length: 257 }, (_, i) => cap(`a.c${i}`)),
      1,
    );
    const result = validateCatalog(many);
    expect(codesOf(result)).toEqual(["CATALOG_TOO_LARGE"]);
    expect(
      codesOf(
        validateCatalog(
          buildCatalog([cap("a.b", { moduleIds: ["a.c/runtime"] })], 1),
        ),
      ),
    ).toContain("INVALID_ID");
  });

  it("rejects core depending on optional, bad text bounds, and slot problems", () => {
    const coreOnOptional = buildCatalog(
      [cap("a.core", { tier: "core", dependencies: ["a.opt"] }), cap("a.opt")],
      1,
    );
    expect(codesOf(validateCatalog(coreOnOptional))).toContain(
      "CORE_DEPENDS_ON_OPTIONAL",
    );
    expect(
      codesOf(
        validateCatalog(
          buildCatalog([cap("a.b", { title: "x".repeat(81) })], 1),
        ),
      ),
    ).toContain("INVALID_LENGTH");
    expect(
      codesOf(
        validateCatalog(
          buildCatalog([cap("a.b", { summary: "x".repeat(401) })], 1),
        ),
      ),
    ).toContain("INVALID_LENGTH");
    const slots = buildCatalog(
      [
        cap("a.b", {
          alternatives: [
            { slot: "t", oneOf: ["a.c"] },
            { slot: "t", oneOf: [] },
          ],
        }),
        cap("a.c"),
      ],
      1,
    );
    const codes = codesOf(validateCatalog(slots));
    expect(codes).toContain("INVALID_ID");
    expect(codes).toContain("INVALID_VALUE");
  });

  it("rejects a stored exposure digest that disagrees with the declaration", () => {
    const [first, ...rest] = FIXTURE_CATALOG.capabilities;
    if (first === undefined) throw new Error("fixture missing");
    const tampered = {
      catalogVersion: 1,
      capabilities: [{ ...first, dependencies: ["settings.core"] }, ...rest],
    };
    expect(codesOf(validateCatalog(tampered))).toContain("INVALID_DIGEST");
  });
});
