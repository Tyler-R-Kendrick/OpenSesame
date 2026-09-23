/**
 * Opaque session-root digest for compartment admission (never raw key material).
 */

import type { VaultHeader } from "@opensesame/vault-core";

export function sessionRootDigestFromHeader(
  header: VaultHeader | null,
  unlocked: boolean,
  ephemeral: boolean,
): string | null {
  if (!unlocked || !header || ephemeral) return null;
  const parts = [
    header.wrap ? JSON.stringify(header.wrap) : "",
    header.kdf ? JSON.stringify(header.kdf) : "",
    header.unlocks?.pin ? JSON.stringify(header.unlocks.pin) : "",
    header.unlocks?.passkey ? JSON.stringify(header.unlocks.passkey) : "",
  ];
  const material = parts.join("|");
  if (!material.replace(/\|/g, "")) return null;
  let hash = 0;
  for (let i = 0; i < material.length; i++) {
    hash = (hash * 31 + material.charCodeAt(i)) >>> 0;
  }
  return `wrap:${hash.toString(16)}`;
}
