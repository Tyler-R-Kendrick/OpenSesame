import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * Vault key protection (ADR 0152, on ADR 0129's manifest): Settings › Security
 * › Vault key protection enrolls an age recipient, an AWS KMS key or a Google
 * Cloud KMS key beside the recovery key and the passkeys, proves each with a
 * Test, chooses the preferred unlock, removes one, and rotates the root key.
 *
 * Which keys can open a person's vault, and which of them may be taken away,
 * is that person's decision. An agent that could enroll a protector could add
 * a way in it holds the other half of; one that could remove or rotate could
 * lock the owner out, and the ceremonies take an age identity, a recovery
 * secret or a cloud credential that never transit agent context (ADR 0005).
 * Password-manager and key-ecosystem bridges are likewise human/device plane
 * only (ADR 0052).
 */
const OWNER_ONLY: CapabilityExclusion = {
  reason:
    "which keys open a person's vault, and which may be removed or rotated, is that person's own decision; the ceremonies take an age identity, a recovery secret or a cloud credential that never transit agent context, and an agent that could enroll or remove a protector could add a way in or lock the owner out",
  adr: "0152-browser-key-protector-enrollment.md",
};

/**
 * The CLIs act on other tombs: `opensesame pass protect` guards the sealed
 * store, and neither CLI opens the browser's vault, whose manifest and
 * credentials are sealed in the page's own at-rest store (ADR 0149).
 */
const NOT_THE_BROWSER_TOMB: CapabilityExclusion = {
  reason:
    "the protectors of the vault in the browser are enrolled, proved and removed in the page that holds its tomb; a CLI has no handle on that manifest (the sealed store's own protectors are `opensesame pass protect`)",
  adr: "0152-browser-key-protector-enrollment.md",
};

export const vaultProtectionCapabilities: readonly Capability[] = [
  {
    id: "vault.protectors.manage",
    title:
      "Vault key protection: enroll a recovery key, passkey, age recipient, AWS KMS or Google Cloud KMS protector, test it, prefer an unlock, or remove it",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/vault/protection/enroll-external.ts:provenExternalRecord",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      cli: NOT_THE_BROWSER_TOMB,
      mcp_host: OWNER_ONLY,
      mcp_client: OWNER_ONLY,
      webmcp: OWNER_ONLY,
    },
  },
  {
    id: "vault.protectors.rotate",
    title:
      "Vault key protection: rotate the vault's root key so a compromised protector stops opening it",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/vault/protection/browser-lifecycle-ops.ts:rotateCompromisedRoot",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      cli: NOT_THE_BROWSER_TOMB,
      mcp_host: OWNER_ONLY,
      mcp_client: OWNER_ONLY,
      webmcp: OWNER_ONLY,
    },
  },
];
