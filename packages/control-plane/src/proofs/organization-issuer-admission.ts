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

function issuerApproved<O>(
  config: ControlPlaneConfig,
  org: Named<O, OrganizationId>,
  issuer: string,
): boolean {
  const normalized = normalizeIssuer(issuer);
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
}

function refusal(): { ok: false; message: string } {
  return {
    ok: false,
    message:
      "The operator must approve this organization's identity-provider issuer.",
  };
}

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
  ].filter((issuer): issuer is string => Boolean(issuer));
  return issuers.every((issuer) => issuerApproved(config, org, issuer))
    ? { ok: true, proof: OrganizationIssuerAdmission.prove(org, configuration) }
    : refusal();
}

/**
 * An existing row may predate the allowlist. Only issuers this write adds or
 * changes need approval; removals and unrelated edits stay possible.
 */
export function organizationIssuerUpdateAdmission<O, C>(
  config: ControlPlaneConfig,
  org: Named<O, OrganizationId>,
  previous: OrganizationIssuerConfiguration | undefined,
  configuration: Named<C, OrganizationIssuerConfiguration>,
):
  | { ok: true; proof: OrganizationIssuerAdmission<O, C> }
  | { ok: false; message: string } {
  const changed: string[] = [];
  for (const [before, after] of [
    [previous?.ssoIssuer, configuration.value.ssoIssuer],
    [previous?.samlIssuer, configuration.value.samlIssuer],
  ] as const) {
    if (
      after &&
      (!before || normalizeIssuer(before) !== normalizeIssuer(after))
    )
      changed.push(after);
  }
  return changed.every((issuer) => issuerApproved(config, org, issuer))
    ? { ok: true, proof: OrganizationIssuerAdmission.prove(org, configuration) }
    : refusal();
}
