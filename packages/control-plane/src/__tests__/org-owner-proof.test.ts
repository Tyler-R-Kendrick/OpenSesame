import { name } from "@gdp-ts/core";
import type {
  OrganizationRole,
  OrganizationState,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { actorId, organizationId } from "../lib/ids.js";
import { type OrgLiveness, orgOwner } from "../proofs/org-owner.js";
import { createAppStores } from "../state.js";

const NOW = new Date("2026-01-01T00:00:00Z");

async function verdictFor(
  state: OrganizationState,
  role: OrganizationRole | undefined,
  liveness: OrgLiveness,
) {
  const stores = createAppStores();
  await stores.organizations.set("org:a", {
    id: "org:a",
    slug: "a",
    displayName: "A",
    state,
    createdBy: "prn_creator",
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (role) {
    await stores.organizationMemberships.upsert({
      organizationId: "org:a",
      principalId: "prn_1",
      role,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return name(actorId("prn_1"), organizationId("org:a"), (actor, org) =>
    orgOwner(stores, actor, org, liveness),
  );
}

/**
 * The three liveness readings are not one rule, and they must stay what each
 * call site always did: collapsing them would change who may manage a
 * suspended, provisional or deleted organization (ADR 0178).
 */
const MATRIX: ReadonlyArray<[OrganizationState, Record<OrgLiveness, boolean>]> =
  [
    ["active", { not_deleted: true, active: true, unchecked: true }],
    ["provisional", { not_deleted: true, active: false, unchecked: true }],
    ["suspended", { not_deleted: true, active: false, unchecked: true }],
    ["deleted", { not_deleted: false, active: false, unchecked: true }],
  ];

describe("orgOwner proof", () => {
  for (const [state, expected] of MATRIX) {
    for (const liveness of ["not_deleted", "active", "unchecked"] as const) {
      it(`an owner of a ${state} organization is ${
        expected[liveness] ? "proven" : "refused 404"
      } under '${liveness}'`, async () => {
        const verdict = await verdictFor(state, "owner", liveness);
        if (expected[liveness]) {
          expect(verdict.ok).toBe(true);
          if (verdict.ok) expect(verdict.proof.kind).toBe("OrgOwner");
        } else {
          expect(verdict).toEqual({
            ok: false,
            status: 404,
            error: "not_found",
          });
        }
      });
    }
  }

  it("answers 403 owner_required for a member who is not an owner", async () => {
    for (const role of ["admin", "member"] as const) {
      expect(await verdictFor("active", role, "not_deleted")).toEqual({
        ok: false,
        status: 403,
        error: "owner_required",
      });
    }
  });

  it("answers 404, never 403, for someone with no membership", async () => {
    expect(await verdictFor("active", undefined, "not_deleted")).toEqual({
      ok: false,
      status: 404,
      error: "not_found",
    });
  });

  it("answers 404 for an organization that does not exist", async () => {
    const stores = createAppStores();
    const verdict = await name(
      actorId("prn_1"),
      organizationId("org:missing"),
      (actor, org) => orgOwner(stores, actor, org, "unchecked"),
    );
    expect(verdict).toEqual({ ok: false, status: 404, error: "not_found" });
  });
});
