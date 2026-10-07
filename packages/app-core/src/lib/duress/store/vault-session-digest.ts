import { assertNotDecoySession } from "../../decoy-session.js";
/**
 * Opaque session-root digest for compartment admission (never raw key material).
 * Key commitment over the session root: a fixed domain-separated plaintext
 * sealed once under a fixed nonce, hashed. Only the holder of the root key can
 * compute it, and plaintext header metadata cannot forge it.
 */

const COMMITMENT_NONCE = new Uint8Array(12);
const COMMITMENT_LABEL = "opensesame.session-root-digest.v1";

export async function sessionRootDigestFromKey(
  vaultKey: CryptoKey | null,
  ephemeral: boolean,
): Promise<string | null> {
  if (!vaultKey || ephemeral) return null;
  const realm = assertNotDecoySession();
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: COMMITMENT_NONCE },
    vaultKey,
    new TextEncoder().encode(COMMITMENT_LABEL),
  );
  assertNotDecoySession(realm);
  const digest = await crypto.subtle.digest("SHA-256", sealed);
  assertNotDecoySession(realm);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `root:${hex}`;
}
