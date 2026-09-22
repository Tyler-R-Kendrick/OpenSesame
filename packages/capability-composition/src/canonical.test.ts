import { describe, expect, it } from "vitest";
import {
  canonicalize,
  digestOf,
  exposureDigest,
  receiptDigest,
  sha256Hex,
} from "./canonical.js";
import { FIXTURE_CATALOG } from "./fixtures.js";

describe("canonicalize", () => {
  it("is key-order independent and recursive", () => {
    const a = canonicalize({ b: 1, a: [{ d: true, c: "x" }], n: null });
    const b = canonicalize({ n: null, a: [{ c: "x", d: true }], b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":[{"c":"x","d":true}],"b":1,"n":null}');
  });

  it("drops undefined object fields and refuses non-JSON", () => {
    expect(canonicalize({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(new Date(0))).toThrow(TypeError);
  });
});

describe("digests", () => {
  it("sha256Hex matches the known vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(digestOf({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("digest determinism: exposureDigest ignores declaration order and non-exposure fields", () => {
    const base = FIXTURE_CATALOG.capabilities.find(
      (d) => d.id === "notifications.web-push",
    );
    if (base === undefined) throw new Error("fixture missing");
    const { exposureDigest: stored, ...declared } = base;
    const reordered = {
      ...declared,
      environments: [...declared.environments].reverse(),
      moduleIds: [...declared.moduleIds].reverse(),
      title: "Renamed",
      summary: "Different summary",
      descriptorVersion: 9,
      operationIds: ["pages.other"],
    };
    expect(exposureDigest(declared)).toBe(stored);
    expect(exposureDigest(reordered)).toBe(stored);
    expect(
      exposureDigest({ ...declared, workerGraphConstraint: null }),
    ).not.toBe(stored);
    expect(
      exposureDigest({
        ...declared,
        egress: [{ class: "external-service", purpose: "x", automatic: true }],
      }),
    ).not.toBe(stored);
  });

  it("digest determinism: receiptDigest ignores root and exposure ordering", () => {
    const body = {
      schemaVersion: 1 as const,
      instanceId: "i",
      installationId: "n",
      policyRevision: "p",
      selectionRevision: "s",
      acceptedAt: "2026-09-22T00:00:00.000Z",
      roots: ["b.x", "a.y"],
      exposure: { "b.x": "sha256:00", "a.y": "sha256:11" },
    };
    const swapped = {
      ...body,
      roots: ["a.y", "b.x"],
      exposure: { "a.y": "sha256:11", "b.x": "sha256:00" },
    };
    expect(receiptDigest(body)).toBe(receiptDigest(swapped));
    expect(
      receiptDigest({ ...body, acceptedAt: "2026-09-23T00:00:00.000Z" }),
    ).not.toBe(receiptDigest(body));
  });
});
