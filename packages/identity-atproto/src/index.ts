import type { AssuranceLevel, ExternalIdentity } from "@opensesame/os-domain";

/**
 * Experimental AT Protocol adapter seam.
 * Disabled unless OPENSESAME_ATPROTO_ENABLED=true.
 * DID is an ExternalIdentity subject — never Principal.id.
 */
export interface AtprotoIdentityAdapter {
  readonly id: "atproto";
  readonly enabled: boolean;
  verifySession(input: {
    did: string;
    pds?: string;
    accessJwt?: string;
  }): Promise<{
    external: Pick<ExternalIdentity, "kind" | "issuer" | "subject" | "assurance">;
  }>;
}

export function createDisabledAtprotoAdapter(): AtprotoIdentityAdapter {
  return {
    id: "atproto",
    enabled: false,
    async verifySession() {
      throw new Error("atproto_adapter_disabled");
    },
  };
}

export const ATPROTO_ASSURANCE: AssuranceLevel = "verified";
