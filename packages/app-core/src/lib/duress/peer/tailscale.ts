/**
 * Tailscale identity as evidence only (PEER-E).
 * Never automatic vault authority; no cert weakening.
 */

export type TailscaleEvidence = Readonly<{
  present: boolean;
  dnsName: string | null;
  tailnetIpv4: string | null;
  loginName: string | null;
  authorityClaim: "none";
  vaultAuthority: false;
  certWeakening: false;
}>;

export function buildTailscaleEvidence(
  input: {
    dnsName?: string | null;
    tailnetIpv4?: string | null;
    loginName?: string | null;
  } | null,
): TailscaleEvidence {
  if (!input) {
    return {
      present: false,
      dnsName: null,
      tailnetIpv4: null,
      loginName: null,
      authorityClaim: "none",
      vaultAuthority: false,
      certWeakening: false,
    };
  }
  const dnsName =
    input.dnsName && input.dnsName.length > 0 && input.dnsName.length <= 253
      ? input.dnsName.toLowerCase()
      : null;
  const loginName =
    input.loginName &&
    input.loginName.length > 0 &&
    input.loginName.length <= 253
      ? input.loginName
      : null;
  const tailnetIpv4 =
    input.tailnetIpv4 &&
    /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.tailnetIpv4)
      ? input.tailnetIpv4
      : null;
  return {
    present: Boolean(dnsName || loginName || tailnetIpv4),
    dnsName,
    tailnetIpv4,
    loginName,
    authorityClaim: "none",
    vaultAuthority: false,
    certWeakening: false,
  };
}

export function tailscaleGrantsVaultAuthority(_e: TailscaleEvidence): false {
  return false;
}

export function allowCertWeakeningForTailscale(_e: TailscaleEvidence): false {
  return false;
}
