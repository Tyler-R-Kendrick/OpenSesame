import { type Organization, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { OrganizationIssuerConflictError } from "../src/repos/interfaces.js";
import { PostgresOrganizationStore } from "../src/repos/organization-stores.js";

const row: Organization = {
  id: "org:driver-error",
  slug: "driver-error",
  displayName: "Driver fixture",
  state: "active",
  createdBy: "owner",
  createdAt: new Date(),
  updatedAt: new Date(),
  ssoIssuer: "https://issuer.example",
};

function storeRejecting(error: Error) {
  return new PostgresOrganizationStore(
    overlapCast({
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => {
            throw error;
          },
        }),
      }),
    }),
  );
}

describe("organization issuer driver error translation", () => {
  for (const field of ["constraint_name", "constraint"] as const) {
    for (const wrapped of [false, true]) {
      it(`maps ${field}, wrapped=${wrapped}, to the public issuer conflict`, async () => {
        const driver = Object.assign(new Error("duplicate issuer"), {
          code: "23505",
          [field]: "organization_issuer_claims_pkey",
        });
        const error = wrapped
          ? new Error("query failed", { cause: driver })
          : driver;
        await expect(
          storeRejecting(error).set(row.id, row),
        ).rejects.toBeInstanceOf(OrganizationIssuerConflictError);
      });
    }
  }

  it("preserves unrelated constraints and non-unique database errors", async () => {
    for (const details of [
      { code: "23505", constraint_name: "organizations_slug_uidx" },
      { code: "23503", constraint_name: "organization_issuer_claims_pkey" },
    ]) {
      const error = Object.assign(new Error("other database failure"), details);
      await expect(storeRejecting(error).set(row.id, row)).rejects.toBe(error);
    }
  });
});
