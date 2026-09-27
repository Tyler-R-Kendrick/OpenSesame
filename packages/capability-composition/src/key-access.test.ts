/**
 * Key access as a set: validation, the normalized classes, and the digest
 * body that keeps every one-class descriptor's exposure digest — and so every
 * consent receipt already signed over it — exactly as it was.
 */
import { describe, expect, it } from "vitest";
import { digestOf, exposureDigest } from "./canonical.js";
import { validateCatalog } from "./catalog.js";
import { FIXTURE_CATALOG } from "./fixtures.js";
import {
  keyAccessClasses,
  keyAccessDigestBody,
  keyAccessProblem,
} from "./key-access.js";
import type { CapabilityDescriptor, KeyAccess } from "./types.js";

const PASSKEYS = FIXTURE_CATALOG.capabilities.find(
  (d) => d.id === "vault.passkey-records",
);

function passkeys(): CapabilityDescriptor {
  if (!PASSKEYS) throw new Error("fixture catalog lost passkey records");
  return PASSKEYS;
}

function withKeyAccess(keyAccess: KeyAccess): CapabilityDescriptor {
  const { exposureDigest: _digest, ...declared } = passkeys();
  const next = { ...declared, keyAccess };
  return { ...next, exposureDigest: exposureDigest(next) };
}

describe("keyAccessProblem", () => {
  it.each([
    ["none", null],
    ["item-plaintext", null],
    [["item-plaintext", "provider-bearer"], null],
    [["none"], null],
    [[], "key access lists at least one class"],
    ["root", "unknown key access class"],
    [["item-plaintext", "root"], "unknown key access class"],
    [["protector-wrap", "protector-wrap"], "key access repeats a class"],
    [["none", "item-plaintext"], "none cannot be combined with another class"],
  ] as const)("%j → %s", (k, problem) => {
    expect(keyAccessProblem(k as KeyAccess)).toBe(problem);
  });

  it("an invalid set is a catalog error at the descriptor's path", () => {
    const catalog = {
      ...FIXTURE_CATALOG,
      capabilities: [withKeyAccess(["none", "provider-bearer"])],
    };
    const result = validateCatalog(catalog);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_VALUE",
          message: "none cannot be combined with another class",
        }),
      ]),
    });
  });
});

describe("keyAccessClasses", () => {
  it("sorts, drops none, and treats a bare class as a set of one", () => {
    expect(keyAccessClasses("none")).toEqual([]);
    expect(keyAccessClasses(["none"])).toEqual([]);
    expect(keyAccessClasses("protector-wrap")).toEqual(["protector-wrap"]);
    expect(keyAccessClasses(["provider-bearer", "item-plaintext"])).toEqual([
      "item-plaintext",
      "provider-bearer",
    ]);
  });
});

describe("the exposure digest", () => {
  it("a single class digests as the bare string it always was", () => {
    const d = passkeys();
    const { exposureDigest: recorded, ...declared } = d;
    // The body exposureDigest built before key access became a set.
    const before = digestOf({
      alternatives: [],
      browserPermissions: [...d.browserPermissions].sort(),
      dependencies: [...d.dependencies].sort(),
      egress: [],
      environments: [...d.environments].sort(),
      id: d.id,
      keyAccess: "item-plaintext",
      moduleIds: [...d.moduleIds].sort(),
      requiresService: d.requiresService,
      workerGraphConstraint: d.workerGraphConstraint,
    });
    expect(recorded).toBe(before);
    expect(exposureDigest(declared)).toBe(before);
    expect(withKeyAccess(["item-plaintext"]).exposureDigest).toBe(before);
    expect(keyAccessDigestBody(["none"])).toBe("none");
  });

  it("a second class changes it, whatever order the classes are listed in", () => {
    const one = withKeyAccess("item-plaintext").exposureDigest;
    const both = withKeyAccess([
      "item-plaintext",
      "provider-bearer",
    ]).exposureDigest;
    expect(both).not.toBe(one);
    expect(
      withKeyAccess(["provider-bearer", "item-plaintext"]).exposureDigest,
    ).toBe(both);
  });
});
