/**
 * Optional descriptors — the vault, sharing and backup families. Default
 * off; each is chosen, reviewed and accepted before its module is fetched.
 */

import { type AuthoredDescriptor, optional } from "./descriptor.js";

export const VAULT_FAMILY_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  optional(
    "vault.passkey-records",
    "Passkey records",
    "Keep passkeys as vault items: the passkey kind, its editor fields and its WebAuthn-backed ceremonies.",
    {
      browserPermissions: ["webauthn"],
      keyAccess: "item-plaintext",
      itemKinds: ["passkey"],
    },
  ),
  optional(
    "vault.certificate-records",
    "Certificate records",
    "Keep X.509 certificates as vault items and issue self-signed ones locally with WebCrypto.",
    {
      keyAccess: "item-plaintext",
      itemKinds: ["certificate"],
    },
  ),
  optional(
    "vault.interop-formats",
    "Import and export formats",
    "Read other managers' exports (KDBX, CXF, CSV, ZIP, browser and manager formats) and write CXF; the Formats panel in Settings.",
    {
      // KDBX key derivation runs Argon2 in Wasm on large files.
      environments: ["document", "dedicated-worker"],
      keyAccess: "item-plaintext",
    },
  ),
  optional(
    "sharing.drops",
    "Secret drops",
    "Share a secret or a small file exactly once through a sealed claim session; the drop kind, its ceremonies and the claim screen.",
    {
      egress: [
        {
          class: "external-service",
          purpose:
            "the configured Identity API's claim sessions, or this origin when Pages hosts the claim",
          automatic: false,
        },
        {
          class: "user-mediated-navigation",
          purpose: "the drop link a person copies or opens",
          automatic: false,
        },
      ],
      browserPermissions: ["clipboard-write"],
      keyAccess: "item-plaintext",
      itemKinds: ["drop"],
      offlineLimits:
        "Creating or opening a drop needs the claim host; sealed drops already in the vault still list.",
    },
  ),
  optional(
    "sharing.household",
    "Household sharing",
    "Share chosen vault items with the people of one household over an explicitly chosen transport.",
    {
      alternatives: [{ slot: "transport", oneOf: ["sharing.drops"] }],
      keyAccess: "item-plaintext",
      offlineLimits: "Sharing waits until the chosen transport is reachable.",
    },
  ),
  optional(
    "backup.git-remote",
    "Git remote backup",
    "Push encrypted vault snapshots to a private repository through the GitHub App or a forge git remote, and sync them back.",
    {
      dependencies: ["connectors.external"],
      operationIds: [
        "backup.status",
        "backup.target.set",
        "sync_targets.read",
        "sync_targets.trigger",
      ],
      egress: [
        {
          class: "external-service",
          purpose:
            "the bound git remote or the GitHub App relay, after every vault mutation",
          automatic: true,
        },
      ],
      keyAccess: "provider-bearer",
      requiresService: true,
      offlineLimits:
        "Snapshots queue locally and push when the remote is reachable.",
    },
  ),
  optional(
    "backup.cloud-secrets",
    "Cloud key services",
    "Wrap the vault key with AWS KMS, GCP KMS, Azure Key Vault, YubiKey PIV or age recipients, and read or write SOPS documents.",
    {
      egress: [
        {
          class: "external-service",
          purpose:
            "the AWS KMS, GCP KMS or Azure Key Vault endpoint a person configured",
          automatic: false,
        },
      ],
      browserPermissions: ["webauthn"],
      keyAccess: "protector-wrap",
      offlineLimits:
        "age and YubiKey protectors work offline; a cloud KMS protector needs its endpoint to unwrap.",
    },
  ),
];
