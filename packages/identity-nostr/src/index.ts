import type { AssuranceLevel, ExternalIdentity } from "@opensesame/os-domain";

/**
 * Experimental Nostr challenge adapter.
 * Public key binds as ExternalIdentity — never Principal.id.
 * Disabled unless OPENSESAME_NOSTR_ENABLED=true.
 */
export interface NostrIdentityAdapter {
  readonly id: "nostr";
  readonly enabled: boolean;
  createChallenge(): Promise<{ challengeId: string; message: string; expiresAt: Date }>;
  verifySignedChallenge(input: {
    challengeId: string;
    pubkey: string;
    signature: string;
  }): Promise<{
    external: Pick<ExternalIdentity, "kind" | "issuer" | "subject" | "assurance">;
  }>;
}

export function createDisabledNostrAdapter(): NostrIdentityAdapter {
  return {
    id: "nostr",
    enabled: false,
    async createChallenge() {
      throw new Error("nostr_adapter_disabled");
    },
    async verifySignedChallenge() {
      throw new Error("nostr_adapter_disabled");
    },
  };
}

export const NOSTR_ASSURANCE: AssuranceLevel = "self_asserted";
