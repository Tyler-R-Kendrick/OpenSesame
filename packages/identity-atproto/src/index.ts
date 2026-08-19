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
    external: Pick<
      ExternalIdentity,
      "kind" | "issuer" | "subject" | "assurance"
    >;
  }>;
}

/** `did:` method + method-specific id. Never a Principal.id. */
export function assertAtprotoDid(did: string): void {
  if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/u.test(did)) {
    throw new Error("atproto_did_invalid");
  }
}

function throwDisabled(): never {
  throw new Error("atproto_adapter_disabled");
}

export function createDisabledAtprotoAdapter(): AtprotoIdentityAdapter {
  return {
    id: "atproto",
    enabled: false,
    async verifySession(input) {
      assertAtprotoDid(input.did);
      throwDisabled();
    },
  };
}

/**
 * Factory used by identity-plane wiring. Stay fail-closed: even when the
 * feature flag is on, there is no live PDS verifier in this package.
 */
export function createAtprotoAdapter(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): AtprotoIdentityAdapter {
  if (env.OPENSESAME_ATPROTO_ENABLED !== "true") {
    return createDisabledAtprotoAdapter();
  }
  return {
    id: "atproto",
    enabled: true,
    async verifySession(input) {
      assertAtprotoDid(input.did);
      throw new Error("atproto_adapter_unimplemented");
    },
  };
}

export const ATPROTO_ASSURANCE: AssuranceLevel = "verified";
