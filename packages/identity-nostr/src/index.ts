import type { AssuranceLevel, ExternalIdentity } from "@opensesame/os-domain";

/**
 * Experimental Nostr challenge adapter.
 * Public key binds as ExternalIdentity — never Principal.id.
 * Disabled unless OPENSESAME_NOSTR_ENABLED=true.
 */
export interface NostrIdentityAdapter {
  readonly id: "nostr";
  readonly enabled: boolean;
  createChallenge(): Promise<{
    challengeId: string;
    message: string;
    expiresAt: Date;
  }>;
  verifySignedChallenge(input: {
    challengeId: string;
    pubkey: string;
    signature: string;
  }): Promise<{
    external: Pick<
      ExternalIdentity,
      "kind" | "issuer" | "subject" | "assurance"
    >;
  }>;
}

/** 32-byte secp256k1 x-only pubkey as lowercase hex. Never a Principal.id. */
export function assertNostrPubkey(pubkey: string): void {
  if (!/^[0-9a-f]{64}$/u.test(pubkey)) {
    throw new Error("nostr_pubkey_invalid");
  }
}

function throwDisabled(): never {
  throw new Error("nostr_adapter_disabled");
}

export function createDisabledNostrAdapter(): NostrIdentityAdapter {
  return {
    id: "nostr",
    enabled: false,
    async createChallenge() {
      throwDisabled();
    },
    async verifySignedChallenge(input) {
      assertNostrPubkey(input.pubkey);
      throwDisabled();
    },
  };
}

/**
 * Factory used by identity-plane wiring. Stay fail-closed: even when the
 * feature flag is on, there is no live signature verifier in this package.
 */
export function createNostrAdapter(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): NostrIdentityAdapter {
  if (env.OPENSESAME_NOSTR_ENABLED !== "true") {
    return createDisabledNostrAdapter();
  }
  return {
    id: "nostr",
    enabled: true,
    async createChallenge() {
      throw new Error("nostr_adapter_unimplemented");
    },
    async verifySignedChallenge(input) {
      assertNostrPubkey(input.pubkey);
      throw new Error("nostr_adapter_unimplemented");
    },
  };
}

export const NOSTR_ASSURANCE: AssuranceLevel = "self_asserted";
