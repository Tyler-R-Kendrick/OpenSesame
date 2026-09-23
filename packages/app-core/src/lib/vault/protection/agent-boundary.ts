/**
 * Agent / ConnectionRef / MCP boundary for human-vault root protection (C11 /
 * KP-39).
 *
 * Human-root unwrap must not be exposed via ConnectionRef invoke, MCP/WebMCP
 * tools, or generic provider crypto aliases that happen to share a KMS key.
 * This module is the deny-list / policy surface; wire call sites as invoke
 * hooks appear. It never returns root material.
 */

import {
  DOMAIN_CAPSULE,
  DOMAIN_CLOUD_WRAP,
  DOMAIN_MANIFEST,
  DOMAIN_MANIFEST_MAC,
  type ProtectionPurpose,
} from "@opensesame/vault-core";
import { ProtectionError } from "./errors.js";

/** Ciphertext domains that bind human-vault root protection material. */
export const ROOT_PROTECTION_DOMAINS = [
  DOMAIN_CAPSULE,
  DOMAIN_CLOUD_WRAP,
  DOMAIN_MANIFEST,
  DOMAIN_MANIFEST_MAC,
] as const;

export type RootProtectionDomain = (typeof ROOT_PROTECTION_DOMAINS)[number];

/**
 * Generic crypto / KMS aliases an agent might request. Exact resource +
 * execution identity isolation is required; these broad verbs are refused for
 * human-root purpose and root-protection domains.
 */
export const AGENT_REFUSED_CRYPTO_ALIASES = [
  "Encrypt",
  "Decrypt",
  "kms:Encrypt",
  "kms:Decrypt",
  "crypto.encrypt",
  "crypto.decrypt",
  "age.encrypt",
  "age.decrypt",
  "unwrap",
  "wrap",
  "opensesame.vault.unwrap_root",
  "opensesame.vault.wrap_root",
] as const;

export type AgentRefusedCryptoAlias =
  (typeof AGENT_REFUSED_CRYPTO_ALIASES)[number];

export function isRootProtectionDomain(domain: string): boolean {
  for (const entry of ROOT_PROTECTION_DOMAINS) {
    if (entry === domain) return true;
  }
  return false;
}

function normalizeAlias(alias: string): string {
  return alias.trim();
}

export function isAgentRefusedCryptoAlias(alias: string): boolean {
  const normalized = normalizeAlias(alias);
  for (const entry of AGENT_REFUSED_CRYPTO_ALIASES) {
    if (entry === normalized) return true;
  }
  return false;
}

export type AgentCryptoRequest = {
  alias: string;
  purpose: ProtectionPurpose;
  /** Domain-separated ciphertext label when known. */
  domain?: string;
};

/**
 * Policy check: may an agent/ConnectionRef/MCP surface run this crypto alias
 * against the given purpose/domain? Human-vault root and root-protection
 * ciphertexts always deny.
 */
export function agentMayInvokeCryptoAlias(
  request: AgentCryptoRequest,
): boolean {
  if (request.purpose === "human-vault-root") return false;
  if (request.domain !== undefined && isRootProtectionDomain(request.domain)) {
    return false;
  }
  // Generic aliases without an explicit non-root domain are the oracle surface
  // against root-protection ciphertexts (KP-39) — refuse rather than guess.
  if (
    isAgentRefusedCryptoAlias(request.alias) &&
    request.domain === undefined
  ) {
    return false;
  }
  return true;
}

/**
 * Fail closed when agent invoke would unwrap or oracle human-root material.
 */
export function assertAgentMayNotUnwrapHumanRoot(
  request: AgentCryptoRequest,
): void {
  if (agentMayInvokeCryptoAlias(request)) return;
  throw new ProtectionError(
    "agent_forbidden",
    "Human-vault root unwrap is not available through ConnectionRef, MCP, or generic crypto aliases.",
  );
}
