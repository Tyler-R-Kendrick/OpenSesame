/**
 * Where a SOPS identity may come from (B07, AGE-03, SB-033, SB-034).
 *
 * Two sources and no others: an identity the person types for this
 * operation, held only in memory, and an identity already sealed in the
 * unlocked vault. There is no home directory, no environment variable, no
 * browser profile, and no scan of unrelated vault entries — and opening or
 * exporting a document never generates or replaces an identity.
 */

import { type AgeKeyConfig, readAgeKeyConfig } from "../../../lib/age-keys.js";
import { parseAgeIdentity } from "../../../lib/sops/keys/age.js";

export type IdentitySources = {
  /** Typed for this operation; never persisted. */
  ephemeral: string;
  /** Identities the unlocked vault already holds. */
  vault: readonly string[];
};

export type VaultAccess = {
  status: string;
  guest: boolean;
  awaitingSecondStep: boolean;
  tomb: string;
};

/** A sealed identity is reachable only from a fully unlocked human session. */
export function mayUseVaultIdentities(access: VaultAccess): boolean {
  return (
    access.status === "unlocked" && !access.guest && !access.awaitingSecondStep
  );
}

/** Read the sealed inventory for this tomb, or nothing when it is gated. */
export async function loadVaultIdentities(
  access: VaultAccess,
): Promise<string[]> {
  if (!mayUseVaultIdentities(access)) return [];
  let config: AgeKeyConfig;
  try {
    config = await readAgeKeyConfig(access.tomb);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of config.identities) {
    if (entry.identity) out.push(entry.identity);
  }
  if (config.identity && !out.includes(config.identity))
    out.push(config.identity);
  return out;
}

/** The identities to try, in order: what was typed, then what is sealed. */
export function identityList(sources: IdentitySources): string[] {
  const out: string[] = [];
  const typed = sources.ephemeral.trim();
  if (typed !== "") out.push(parseAgeIdentity(typed));
  for (const identity of sources.vault)
    if (!out.includes(identity)) out.push(identity);
  return out;
}

/** The recipients a vault holds, offered as one-tap fills when encrypting. */
export async function loadVaultRecipients(
  access: VaultAccess,
): Promise<string[]> {
  if (!mayUseVaultIdentities(access)) return [];
  try {
    return [...(await readAgeKeyConfig(access.tomb)).recipients];
  } catch {
    return [];
  }
}
