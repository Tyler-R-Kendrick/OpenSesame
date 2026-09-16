import { describe, expect, it } from "vitest";
import type { AuthorizationDetail } from "../authorization-details.js";
import {
  authorizationDetailsFromPermissionSet,
  permissionSetFromAuthorizationDetails,
} from "../permission-details.js";
import {
  emptyPermissionSet,
  entryContains,
  entryPermits,
  flattenLossless,
  permissionEntry,
  permissionSet,
  permissionSetFromFlat,
  projectedActions,
  setAttenuates,
  setPermits,
  splitFlat,
} from "../permission-entry.js";
import {
  encodeResourceScope,
  parseResourceScope,
  scopeContains,
  scopeMatches,
} from "../permission-scope.js";

const readAWriteB = () =>
  permissionSet([
    permissionEntry(["repository.read"], ["repo:acme/a"]),
    permissionEntry(["repository.write"], ["repo:acme/b"]),
  ]);

describe("resource selectors", () => {
  it("matches an exact id and nothing longer", () => {
    const scope = parseResourceScope("repo:acme/catalog");
    expect(scopeMatches(scope, "repo:acme/catalog")).toBe(true);
    expect(scopeMatches(scope, "repo:acme/catalog-private")).toBe(false);
    expect(scopeMatches(scope, "repo:acme/catalog/sub")).toBe(false);
  });

  it("bounds a subtree at its separator", () => {
    const scope = parseResourceScope("repo:acme/*");
    expect(scopeMatches(scope, "repo:acme/catalog")).toBe(true);
    expect(scopeMatches(scope, "repo:acme/team/catalog")).toBe(true);
    expect(scopeMatches(scope, "repo:acme-private/catalog")).toBe(false);
    expect(scopeMatches(scope, "repo:acme/")).toBe(false);
    expect(scopeMatches(scope, "repo:acme")).toBe(false);
  });

  it("refuses a bare prefix and anything shaped like a pattern", () => {
    for (const pattern of [
      "repo:acme*",
      "*acme",
      "repo:*/catalog",
      "repo:acme/.*",
      "repo:acme/.+",
      "repo:acme/**",
      "repo:acme/?",
      "repo:[^a]/x",
      "",
      " repo:acme/catalog",
      "/*",
    ]) {
      expect(() => parseResourceScope(pattern), pattern).toThrow();
    }
  });

  it("round-trips its encoding", () => {
    for (const pattern of [
      "*",
      "repo:acme/catalog",
      "repo:acme/*",
      "connection:abc:*",
    ]) {
      expect(encodeResourceScope(parseResourceScope(pattern))).toBe(pattern);
    }
  });

  it("contains only what it narrows to", () => {
    const all = parseResourceScope("*");
    const subtree = parseResourceScope("repo:acme/*");
    const nested = parseResourceScope("repo:acme/team/*");
    const exact = parseResourceScope("repo:acme/catalog");
    const sibling = parseResourceScope("repo:acme-private/*");

    expect(scopeContains(all, subtree)).toBe(true);
    expect(scopeContains(subtree, exact)).toBe(true);
    expect(scopeContains(subtree, nested)).toBe(true);
    expect(scopeContains(subtree, all)).toBe(false);
    expect(scopeContains(exact, subtree)).toBe(false);
    expect(scopeContains(nested, subtree)).toBe(false);
    expect(scopeContains(subtree, sibling)).toBe(false);
  });
});

describe("permission entries", () => {
  it("needs both halves of a pair in the same entry", () => {
    const entry = permissionEntry(["repository.read"], ["repo:acme/catalog"]);
    expect(entryPermits(entry, "repository.read", "repo:acme/catalog")).toBe(
      true,
    );
    expect(entryPermits(entry, "repository.write", "repo:acme/catalog")).toBe(
      false,
    );
    expect(entryPermits(entry, "repository.read", "repo:victim/secrets")).toBe(
      false,
    );
  });

  it("is a deliberate product within one entry", () => {
    const entry = permissionEntry(
      ["repository.read", "repository.write"],
      ["repo:acme/a", "repo:acme/b"],
    );
    for (const action of ["repository.read", "repository.write"]) {
      for (const resource of ["repo:acme/a", "repo:acme/b"]) {
        expect(entryPermits(entry, action, resource)).toBe(true);
      }
    }
  });

  it("refuses an empty side or a name that is not bare", () => {
    expect(() => permissionEntry([], ["repo:acme/a"])).toThrow();
    expect(() => permissionEntry(["read"], [])).toThrow();
    expect(() => permissionEntry([""], ["repo:acme/a"])).toThrow();
    expect(() => permissionEntry([" read"], ["repo:acme/a"])).toThrow();
    expect(() => permissionEntry(["read"], ["repo:acme*"])).toThrow();
  });

  it("canonicalizes to sorted, deduplicated sides", () => {
    const entry = permissionEntry(
      ["b", "a", "a"],
      ["repo:acme/z", "repo:acme/a", "repo:acme/a"],
    );
    expect(entry.actions).toEqual(["a", "b"]);
    expect(entry.resources.map(encodeResourceScope)).toEqual([
      "repo:acme/a",
      "repo:acme/z",
    ]);
  });

  it("contains narrower entries only", () => {
    const parent = permissionEntry(
      ["repository.read", "repository.write"],
      ["repo:acme/*"],
    );
    const child = permissionEntry(["repository.read"], ["repo:acme/catalog"]);
    expect(entryContains(parent, child)).toBe(true);
    expect(entryContains(child, parent)).toBe(false);
    expect(
      entryContains(
        parent,
        permissionEntry(["repository.admin"], ["repo:acme/catalog"]),
      ),
    ).toBe(false);
  });
});

describe("permission sets", () => {
  it("never turns read A and write B into write A", () => {
    const set = readAWriteB();
    expect(setPermits(set, "repository.read", "repo:acme/a")).toBe(true);
    expect(setPermits(set, "repository.write", "repo:acme/b")).toBe(true);
    expect(setPermits(set, "repository.write", "repo:acme/a")).toBe(false);
    expect(setPermits(set, "repository.read", "repo:acme/b")).toBe(false);
    // Each half is present somewhere, which is exactly why the projections
    // are not the authority.
    expect(projectedActions(set)).toContain("repository.write");
  });

  it("reads a flat pair as the product it always was", () => {
    const set = permissionSetFromFlat(
      ["repository.read", "repository.write"],
      ["repo:acme/a", "repo:acme/b"],
    );
    expect(set.entries).toHaveLength(1);
    expect(setPermits(set, "repository.write", "repo:acme/a")).toBe(true);
    expect(set).not.toEqual(readAWriteB());
  });

  it("refuses to flatten a correlated set, naming the gained pair", () => {
    expect(() => flattenLossless(readAWriteB())).toThrow(
      /flattening would authorize a pair nobody granted/,
    );
  });

  it("flattens when flattening changes nothing", () => {
    expect(
      flattenLossless(
        permissionSetFromFlat(["read", "write"], ["repo:acme/a"]),
      ),
    ).toEqual({ actions: ["read", "write"], resources: ["repo:acme/a"] });

    const tiled = permissionSet([
      permissionEntry(["read"], ["repo:acme/a", "repo:acme/b"]),
      permissionEntry(["write"], ["repo:acme/a", "repo:acme/b"]),
    ]);
    expect(() => flattenLossless(tiled)).not.toThrow();
  });

  it("splits into one flat record per entry", () => {
    expect(splitFlat(readAWriteB())).toEqual([
      { actions: ["repository.read"], resources: ["repo:acme/a"] },
      { actions: ["repository.write"], resources: ["repo:acme/b"] },
    ]);
  });

  it("refuses cross-entry recombination in attenuation", () => {
    const parent = readAWriteB();
    expect(
      setAttenuates(
        permissionSet([permissionEntry(["repository.read"], ["repo:acme/a"])]),
        parent,
      ),
    ).toBe(true);
    expect(
      setAttenuates(
        permissionSet([permissionEntry(["repository.write"], ["repo:acme/a"])]),
        parent,
      ),
    ).toBe(false);
    expect(
      setAttenuates(
        permissionSet([
          permissionEntry(
            ["repository.read", "repository.write"],
            ["repo:acme/a", "repo:acme/b"],
          ),
        ]),
        parent,
      ),
    ).toBe(false);
  });

  it("does not let a subtree child swallow two exact parents", () => {
    const parent = permissionSet([
      permissionEntry(["read"], ["repo:acme/a"]),
      permissionEntry(["read"], ["repo:acme/b"]),
    ]);
    expect(
      setAttenuates(
        permissionSet([permissionEntry(["read"], ["repo:acme/*"])]),
        parent,
      ),
    ).toBe(false);
    expect(
      setAttenuates(permissionSet([permissionEntry(["read"], ["*"])]), parent),
    ).toBe(false);
  });

  it("orders entries canonically, so order is not authority", () => {
    const backward = permissionSet([
      permissionEntry(["repository.write"], ["repo:acme/b"]),
      permissionEntry(["repository.read"], ["repo:acme/a"]),
    ]);
    expect(backward).toEqual(readAWriteB());
  });

  it("treats an empty set as empty authority, not open authority", () => {
    const set = emptyPermissionSet();
    expect(setPermits(set, "read", "repo:acme/a")).toBe(false);
    expect(flattenLossless(set)).toEqual({ actions: [], resources: [] });
  });
});

describe("RFC 9396 authorization_details", () => {
  const details = (): AuthorizationDetail[] => [
    {
      type: "connector_operation",
      actions: ["repository.read"],
      locations: ["repo:acme/a"],
    },
    {
      type: "connector_operation",
      actions: ["repository.write"],
      locations: ["repo:acme/b"],
    },
  ];

  it("keeps one element as one entry", () => {
    const set = permissionSetFromAuthorizationDetails(details());
    expect(set).toEqual(readAWriteB());
    expect(setPermits(set, "repository.write", "repo:acme/a")).toBe(false);
  });

  it("cannot be flattened into a single two-list record", () => {
    const set = permissionSetFromAuthorizationDetails(details());
    expect(() => flattenLossless(set)).toThrow();
    expect(splitFlat(set)).toHaveLength(2);
  });

  it("requires every element to say what it is for", () => {
    const bad: AuthorizationDetail[][] = [
      [{ type: "connector_operation", actions: ["read"] }],
      [{ type: "connector_operation", locations: ["repo:acme/a"] }],
      [{ type: "", actions: ["read"], locations: ["repo:acme/a"] }],
      [{ type: "x", actions: "read", locations: ["repo:acme/a"] }],
      [{ type: "x", actions: [1], locations: ["repo:acme/a"] }],
      [{ type: "x", actions: ["read"], locations: ["repo:acme*"] }],
      [],
    ];
    for (const details of bad) {
      expect(
        () => permissionSetFromAuthorizationDetails(details),
        JSON.stringify(details),
      ).toThrow();
    }
  });

  it("reads identifier as a location, not a second axis", () => {
    const set = permissionSetFromAuthorizationDetails([
      {
        type: "connector_operation",
        actions: ["repository.read"],
        locations: ["repo:acme/a"],
        identifier: "repo:acme/b",
      },
    ]);
    expect(set.entries).toHaveLength(1);
    expect(setPermits(set, "repository.read", "repo:acme/b")).toBe(true);
  });

  it("renders back to one element per entry", () => {
    const set = readAWriteB();
    const rendered = authorizationDetailsFromPermissionSet(
      set,
      "connector_operation",
    );
    expect(rendered).toEqual(details());
    expect(permissionSetFromAuthorizationDetails(rendered)).toEqual(set);
  });
});
