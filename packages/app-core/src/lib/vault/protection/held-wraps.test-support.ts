import type { VaultHeader, VaultUnlocks } from "@opensesame/vault-core";

/** Which wraps a fixture vault's header holds. */
export type HeldWraps = {
  password?: boolean;
  pin?: boolean;
  passkey?: boolean;
  totp?: boolean;
};

const KDF = {
  alg: "PBKDF2-SHA256",
  saltB64: "c2FsdA==",
  iterations: 1,
} as const;
const WRAP = { ivB64: "aXY=", ctB64: "Y3Q=" };

/**
 * A header that holds exactly the wraps named, in the shape the unlock and
 * protection screens read. The bytes are placeholders: nothing here opens.
 */
export function headerHolding(held: HeldWraps): VaultHeader {
  const unlocks: VaultUnlocks = {};
  if (held.pin) unlocks.pin = { kdf: KDF, wrap: WRAP };
  if (held.passkey) {
    unlocks.passkey = {
      credentialIdB64: "Y3JlZA==",
      userIdB64: "dXNlcg==",
      prfSaltB64: "c2FsdA==",
      wrap: WRAP,
    };
  }
  if (held.totp) {
    unlocks.totp = { secretWrap: WRAP, digits: 6, period: 30 };
  }
  const header: VaultHeader = {
    v: 1,
    createdAt: "2026-10-07T00:00:00.000Z",
    unlocks,
  };
  if (held.password) {
    header.kdf = KDF;
    header.wrap = WRAP;
  }
  return header;
}
