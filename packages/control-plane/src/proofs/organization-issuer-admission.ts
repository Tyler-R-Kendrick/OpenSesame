import { type Named, type Proof, defineProof } from "@gdp-ts/core";
import type { Organization } from "@opensesame/os-domain";
import type { ControlPlaneConfig } from "../config.js";
import { normalizeIssuer } from "../interactions/registry.js";
import type { OrganizationId } from "../lib/ids.js";

export type OrganizationIssuerConfiguration = Pick<
  Organization,
  "ssoIssuer" | "samlIssuer"
>;
const OrganizationIssuerAdmission = defineProof("OrganizationIssuerAdmission");
export interface OrganizationIssuerAdmission<O, C>
  extends Proof<"OrganizationIssuerAdmission", [O, C]> {}

/** Operator approval binds the exact tenant and the exact configuration admitted. */
export function organizationIssuerAdmission<O, C>(
  config: ControlPlaneConfig,
  org: Named<O, OrganizationId>,
  configuration: Named<C, OrganizationIssuerConfiguration>,
):
  | { ok: true; proof: OrganizationIssuerAdmission<O, C> }
  | { ok: false; message: string } {
  const issuers = [
    configuration.value.ssoIssuer,
    configuration.value.samlIssuer,
  ].filter(Boolean);
  const approved = issuers.every((issuer) => {
    const normalized = normalizeIssuer(issuer ?? "");
    return (
      normalized.length > 0 &&
      (config.organizationIssuerAllowlist ?? []).some((approval) => {
        const separator = approval.indexOf("|");
        return (
          separator > 0 &&
          approval.slice(0, separator) === org.value &&
          normalizeIssuer(approval.slice(separator + 1)) === normalized
        );
      })
    );
  });
  return approved
    ? { ok: true, proof: OrganizationIssuerAdmission.prove(org, configuration) }
    : {
        ok: false,
        message:
          "The operator must approve this organization's identity-provider issuer.",
      };
}
