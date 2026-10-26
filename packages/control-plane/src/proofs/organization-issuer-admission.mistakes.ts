import { name } from "@gdp-ts/core";
import type { Organization } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { claimAdmittedSamlEntityId } from "../interactions/saml-issuer-claim.js";
import { organizationId } from "../lib/ids.js";
import {
  verifyAdmittedOrganizationAssertion,
  writeIssuerAdmittedOrganization,
} from "../services/org-issuer-approval.js";
import { organizationIssuerAdmission } from "./organization-issuer-admission.js";

/** Exact organization and configuration names are invariant across admission. */
export async function organizationIssuerAdmissionMistakes(
  ctx: AppContext,
  row: Organization,
) {
  await name(
    organizationId("org:a"),
    organizationId("org:b"),
    row,
    async (orgA, orgB, rowA) => {
      await name({ ...row }, async (rowB) => {
        const verdict = organizationIssuerAdmission(ctx.config, orgA, rowA);
        if (!verdict.ok) return;
        await writeIssuerAdmittedOrganization(ctx, orgA, rowA, verdict.proof);
        // @ts-expect-error — approval for A cannot authorize B.
        await writeIssuerAdmittedOrganization(ctx, orgB, rowA, verdict.proof);
        // @ts-expect-error — approval cannot authorize an unchecked configuration.
        await writeIssuerAdmittedOrganization(ctx, orgA, rowB, verdict.proof);
        // @ts-expect-error — deployment approval is mandatory.
        await writeIssuerAdmittedOrganization(ctx, orgA, rowA);
        // @ts-expect-error — a refusal/verdict is not an admission proof.
        await writeIssuerAdmittedOrganization(ctx, orgA, rowA, verdict);
      });
    },
  );
  await name(
    organizationId("org:a"),
    { samlIssuer: "https://idp.example" },
    { samlIssuer: "https://attacker.example" },
    async (org, claim, other) => {
      const verdict = organizationIssuerAdmission(ctx.config, org, claim);
      if (!verdict.ok) return;
      await claimAdmittedSamlEntityId(ctx, org, claim, verdict.proof);
      // @ts-expect-error — an approved entityID cannot authorize another entityID.
      await claimAdmittedSamlEntityId(ctx, org, other, verdict.proof);
    },
  );
  await name(
    organizationId("org:a"),
    { ssoIssuer: "https://idp.example" },
    { ssoIssuer: "https://attacker.example" },
    async (org, claim, other) => {
      const verdict = organizationIssuerAdmission(ctx.config, org, claim);
      if (!verdict.ok) return;
      await verifyAdmittedOrganizationAssertion(
        ctx,
        org,
        claim,
        verdict.proof,
        "token",
      );
      await verifyAdmittedOrganizationAssertion(
        ctx,
        org,
        other,
        // @ts-expect-error — issuer approval cannot verify an assertion at another issuer.
        verdict.proof,
        "token",
      );
      // @ts-expect-error — token verification needs the deployment approval proof.
      await verifyAdmittedOrganizationAssertion(ctx, org, claim, "token");
    },
  );
}
