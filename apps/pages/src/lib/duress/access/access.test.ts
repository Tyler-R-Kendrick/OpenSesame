/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canAccess } from "../../local-rbac.js";
import { overlapCast } from "../json-boundary.js";
import { DuressSessionFence } from "../session/fence.js";
import { narrowCapabilities } from "./capability-narrow.js";
import {
  type AccessContextClaims,
  type AccessContextProbe,
  assertContextAllows,
  intersectDenyCeilings,
  isAccessContext,
  issueAccessContext,
  parsePublicAccessMetadata,
  publicAccessMetadata,
} from "./context.js";
import { canAccessWithFence, roleUnderFence } from "./iam.js";
import { assertProtectedOperation, withProtectedOperation } from "./protect.js";

function claims(
  overrides: Partial<AccessContextClaims> = {},
): AccessContextClaims {
  return {
    principalRef: "p1",
    tenantRef: null,
    vaultRef: "v1",
    compartmentRefs: ["c1"],
    deviceBindingRef: "d1",
    presentation: "restricted",
    authorizationCeiling: ["read_item"],
    denyOperations: ["export_root"],
    policyRevision: 2,
    incidentEpoch: 3,
    keyEpoch: 4,
    sessionGeneration: 5,
    profileId: "prof",
    evidenceDigest: "digest0123456789ab",
    ...overrides,
  };
}

describe("opaque AccessContext (AUTH-A/F)", () => {
  it("rejects forged public metadata as authority", () => {
    const ctx = issueAccessContext(claims());
    const forged = {
      ...publicAccessMetadata(ctx),
      claims: structuredClone(ctx.claims),
    };
    expect(isAccessContext(overlapCast<AccessContextProbe>(forged))).toBe(
      false,
    );
    expect(() =>
      assertContextAllows(
        // SAFETY: forged lacks CONTEXT_BRAND + issued WeakSet entry; cast reaches fail-closed guard.
        overlapCast<typeof forged, import("./context.js").AccessContext>(
          forged,
        ),
        "read_item",
        {
          policyRevision: 2,
          incidentEpoch: 3,
          keyEpoch: 4,
          sessionGeneration: 5,
        },
      ),
    ).toThrow(/forged|stale_session/);
  });

  it("serialization of public metadata never authenticates", () => {
    const ctx = issueAccessContext(claims());
    const wire = JSON.stringify(publicAccessMetadata(ctx));
    const parsed = parsePublicAccessMetadata(JSON.parse(wire));
    expect(parsed?.incidentEpoch).toBe(3);
    expect(isAccessContext(parsed)).toBe(false);
    expect(isAccessContext(JSON.parse(wire))).toBe(false);
  });

  it("narrows IAM grants under deny + ceiling", () => {
    expect(
      narrowCapabilities(
        ["read_item", "export_root", "mint_grant"],
        ["export_root"],
        ["read_item", "mint_grant"],
      ),
    ).toEqual(["read_item", "mint_grant"]);
  });

  it("intersects deny ceilings across concurrent incidents", () => {
    expect(
      intersectDenyCeilings([
        { denyOperations: ["a", "b"] },
        { denyOperations: ["b", "c"] },
      ]),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("IAM under fence (AUTH-B)", () => {
  it("demotes restricted presentation to guest and denies capabilities", () => {
    const fence = new DuressSessionFence("iam-test");
    fence.activate({
      incidentId: "i1",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["manage_grants"],
      admittedCompartmentRefs: ["c1"],
    });
    const ctx = issueAccessContext(
      claims({
        presentation: "restricted",
        authorizationCeiling: [],
        denyOperations: ["manage_grants"],
        policyRevision: 1,
        incidentEpoch: fence.readFence().incidentEpoch,
        keyEpoch: 1,
        sessionGeneration: fence.guard.generation,
        profileId: "p",
      }),
    );
    expect(roleUnderFence("operator", fence.readFence(), ctx)).toBe("guest");
    expect(
      canAccessWithFence(
        "operator",
        "manage_grants",
        fence.readFence(),
        ctx,
        canAccess,
      ),
    ).toBe(false);
  });
});

describe("protected operations (AUTH-D/F)", () => {
  it("refuses forged handles", () => {
    expect(() =>
      assertProtectedOperation({
        ctx: overlapCast<
          { presentation: string },
          import("./context.js").AccessContext
        >({
          presentation: "restricted",
        }),
        operation: "export_root",
        expected: {
          policyRevision: 1,
          incidentEpoch: 1,
          keyEpoch: 1,
          sessionGeneration: 1,
        },
      }),
    ).toThrow(/stale_session/);
  });

  it("detects simultaneous revoke during protected use", async () => {
    const ctx = issueAccessContext(
      claims({
        presentation: "restricted",
        authorizationCeiling: ["release_secret"],
        denyOperations: [],
        policyRevision: 1,
        incidentEpoch: 1,
        keyEpoch: 1,
        sessionGeneration: 1,
      }),
    );
    let generation = 1;
    await expect(
      withProtectedOperation(
        {
          ctx,
          operation: "release_secret",
          expected: {
            policyRevision: 1,
            incidentEpoch: 1,
            keyEpoch: 1,
            sessionGeneration: 1,
          },
          currentGeneration: () => generation,
        },
        async () => {
          generation = 99;
          return "leak";
        },
      ),
    ).rejects.toThrow(/generation changed/);
  });

  it("rejects stale handles after generation bump", () => {
    const fence = new DuressSessionFence("stale-handle");
    fence.activate({
      incidentId: "i1",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: [],
      admittedCompartmentRefs: ["c1"],
    });
    const ctx = issueAccessContext(
      claims({
        presentation: "restricted",
        authorizationCeiling: ["read_item"],
        denyOperations: [],
        policyRevision: 1,
        incidentEpoch: fence.readFence().incidentEpoch,
        keyEpoch: 1,
        sessionGeneration: fence.guard.generation,
      }),
    );
    fence.guard.bump();
    expect(() =>
      assertContextAllows(ctx, "read_item", {
        policyRevision: 1,
        incidentEpoch: fence.readFence().incidentEpoch,
        keyEpoch: 1,
        sessionGeneration: fence.guard.generation,
      }),
    ).toThrow(/stale_session/);
  });
});

describe("guest onboarding preserved (AUTH-B)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("empty fence does not demote ordinary operator role", () => {
    const fence = new DuressSessionFence("guest-ok");
    expect(fence.readFence().activeIncidentIds).toEqual([]);
    expect(roleUnderFence("operator", fence.readFence(), null)).toBe(
      "operator",
    );
    expect(
      canAccessWithFence(
        "operator",
        "manage_grants",
        fence.readFence(),
        null,
        canAccess,
      ),
    ).toBe(true);
  });
});
