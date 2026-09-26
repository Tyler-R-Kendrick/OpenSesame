/**
 * Always-on descriptors: core tier, so every plan carries them and no
 * Settings screen offers a switch for them, but each one's code still
 * arrives as its `<id>/runtime` module through the loader after boot
 * (`alwaysOn` in `descriptor.ts`). These are the functions a person uses the
 * application *with* — passkeys, formats, certificates, key protectors, the
 * Connections catalogue, operator identity providers, ambient sign-on, the
 * Access section, the activity trail and guided help — as opposed to the
 * features a person or operator chooses to take on (`features.ts`).
 */

import { type AuthoredDescriptor, alwaysOn } from "./descriptor.js";

const IDENTITY_API_EGRESS = {
  class: "external-service",
  purpose: "the configured Identity API",
  automatic: false,
} as const;

export const ALWAYS_ON_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  alwaysOn(
    "vault.passkey-records",
    "Passkey records",
    "Keep passkeys as vault items: the passkey kind, its editor fields and its WebAuthn-backed ceremonies.",
    {
      browserPermissions: ["webauthn"],
      keyAccess: "item-plaintext",
      itemKinds: ["passkey"],
    },
  ),
  alwaysOn(
    "vault.certificate-records",
    "Certificate records",
    "Keep X.509 certificates as vault items and issue self-signed ones locally with WebCrypto.",
    {
      keyAccess: "item-plaintext",
      itemKinds: ["certificate"],
    },
  ),
  alwaysOn(
    "vault.interop-formats",
    "Import and export formats",
    "Read other managers' exports (KDBX, CXF, CSV, ZIP, browser and manager formats) and write CXF; the Formats panel in Settings.",
    {
      // KDBX key derivation runs Argon2 in Wasm on large files.
      environments: ["document", "dedicated-worker"],
      keyAccess: "item-plaintext",
    },
  ),
  alwaysOn(
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
  alwaysOn(
    "connectors.external",
    "External connectors",
    "The Connections section and Access › Connectors: the embedded catalogue, Vercel Connect sessions, the GitHub App, and a Nango-compatible directory read by reference.",
    {
      operationIds: [
        "connections.bindings",
        "connections.create",
        "connections.credential.set",
        "connections.inspect",
        "connections.list",
        "connections.remove",
        "connectors.bind",
        "connectors.directory.sync",
        "integrations.read",
        "providers.list",
      ],
      egress: [
        {
          class: "external-service",
          purpose:
            "the Vercel Connect relay, the GitHub App relay and a Nango-compatible connector directory",
          automatic: false,
        },
        {
          class: "user-mediated-navigation",
          purpose: "OAuth authorization at the provider a person chose",
          automatic: false,
        },
      ],
      keyAccess: "provider-bearer",
      requiresService: true,
      offlineLimits:
        "The embedded catalogue stays browsable; live connections and the directory need their relays.",
    },
  ),
  alwaysOn(
    "access.authority",
    "Access authority",
    "The Access section: local grants, requests and the requests addressed to your Identity session, sessions, resources and policies, receipts, browser pairing and transport status.",
    {
      operationIds: [
        "agent_identities.read",
        "authority.portal.templates.manage",
        "authority.portal.templates.read",
        "browser.client.revoke",
        "browser.grant.renew",
        "browser.identity.authenticate",
        "browser.pairing.begin",
        "changelog.read",
        "configs.browse",
        "configs.permissions.read",
        "configs.set",
        "delegations.claim",
        "host.health.pages",
        "host.whoami",
        "identity.approval.requests",
        "identity.local.access.manage",
        "identity.local.policy.manage",
        "identity.local.requests.manage",
        "receipts.read",
        "shared_sessions.join_request",
        "transport.capabilities.discover",
        "transport.identity.reference",
        "transport.status.view",
        "transport.verify.run",
      ],
      egress: [
        {
          class: "external-service",
          purpose:
            "the configured Host API and Identity API, or the endpoint a join ceremony names",
          automatic: false,
        },
        {
          class: "peer-or-local-network",
          purpose:
            "a Host or daemon on the local network or tailnet during browser pairing",
          automatic: false,
        },
      ],
      browserPermissions: ["webauthn"],
      offlineLimits:
        "Local grants, requests and policies work offline; Host sessions, delegations and receipts need the Host.",
    },
  ),
  alwaysOn(
    "identity.federation",
    "Operator identity providers",
    "Sign in through operator-registered OpenID providers, bring-your-own issuers and the Identity API's directory: the Providers tab, the setup identity and MFA tabs, and the account's own passkeys and authenticator app as rows in Settings › Security.",
    {
      operationIds: [
        "identity.account_factors.list",
        "identity.account_factors.enroll",
        "identity.account_factors.remove",
      ],
      egress: [
        IDENTITY_API_EGRESS,
        {
          class: "user-mediated-navigation",
          purpose: "the OpenID redirect to a provider a person pressed",
          automatic: false,
        },
      ],
      requiresService: true,
      offlineLimits:
        "Provider sign-in needs the Identity API and the provider.",
    },
  ),
  alwaysOn(
    "identity.ceremonies",
    "Ceremonies",
    "The routes a link opens on this origin (ADR 0140): device sign-in approval at /device and the older links to it; claims and drops at /claim; a cross-device approval at /i/<ref> and a request review at /approve/<ref>, each decided with a passkey touch bound to it; the app hand-off at /invoke/<kind>. They open before unlock and never read the vault.",
    {
      operationIds: [
        "identity.device.approve",
        "identity.claim.accept",
        "identity.drop.open",
        "identity.interaction.approve",
        "identity.interaction.deny",
        "identity.approval.activation",
        "identity.approval.comparison",
        "identity.approval.report",
        "identity.authenticator.invoke",
      ],
      egress: [IDENTITY_API_EGRESS],
      browserPermissions: ["webauthn"],
      requiresService: true,
      offlineLimits:
        "The routes open and show what their link carried offline; approving a device or a request, accepting a claim or opening a drop needs the claim host.",
    },
  ),
  alwaysOn(
    "identity.ambient-sso",
    "Ambient single sign-on",
    "Silent sign-in on boot through Microsoft Entra or another configured provider, with the MSAL redirect bridge page.",
    {
      dependencies: ["identity.federation"],
      egress: [
        {
          class: "external-service",
          purpose:
            "Microsoft Entra or the configured OpenID provider, for a silent token on boot",
          automatic: true,
        },
      ],
      requiresService: true,
      requiresDocumentReload: true,
      offlineLimits:
        "Silent sign-in is skipped offline; the saved session is used.",
    },
  ),
  alwaysOn(
    "activity.log",
    "Activity log",
    "The durable, sealed trail of consequential events and the Activity section that lists it.",
    {
      keyAccess: "item-plaintext",
    },
  ),
  alwaysOn(
    "support.guided-help",
    "Guided help",
    "The support panel, help topics and Driver.js guides that point at authored targets and never act.",
    {
      operationIds: ["client.support", "client.tutorial"],
    },
  ),
];
