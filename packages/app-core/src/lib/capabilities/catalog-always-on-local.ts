/**
 * Browser-local descriptors. Each runs in this browser on the static front
 * end: no automatic call until a person binds something.
 *
 * Always on (ADR 0142): the site broker, and git backup. A git history
 * remote defaults to GitHub, so listing git backup as deselected
 * misdescribed the default install. Git backup does not depend on the
 * Connections section (ADR 0153).
 *
 * Optional, off until the Identity switch (ADR 0153): `identity.local-iam`
 * and `identity.siop`, the Identity section.
 */

import { type AuthoredDescriptor, alwaysOn, optional } from "./descriptor.js";

export const CLI_APP_INTEGRATION_PURPOSE =
  "the local daemon's CLI app-integration routes while OpenSesame is unlocked";

export const BROWSER_LOCAL_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  optional(
    "identity.local-iam",
    "Browser-local IAM",
    "This device as an identity host: the local directory of people, agents, devices and applications, local passkeys, application sign-in and grants.",
    {
      operationIds: [
        "identity.local.agent.keys.manage",
        "identity.local.application.authorize",
        "identity.local.directory.manage",
        "identity.local.organizations.membership.manage",
        "identity.local.organizations.read",
        "identity.local.passkeys.manage",
      ],
      egress: [
        {
          class: "user-mediated-navigation",
          purpose: "the redirect back to a registered local application",
          automatic: false,
        },
      ],
      browserPermissions: ["webauthn"],
      keyAccess: "protector-wrap",
    },
  ),
  optional(
    "identity.siop",
    "Self-issued OpenID",
    "Answer SIOPv2 requests from a registered local application with a self-issued token, gated on a passkey identity.",
    {
      dependencies: ["identity.local-iam"],
      operationIds: ["identity.local.siop.authorize"],
      egress: [
        {
          class: "user-mediated-navigation",
          purpose: "the fragment redirect back to the requesting application",
          automatic: false,
        },
      ],
      browserPermissions: ["webauthn"],
    },
  ),
  alwaysOn(
    "identity.site-broker",
    "Sign-in broker for sites",
    "Broker a brokered identity to approved relying sites over postMessage: the broker popup, the per-site consents and domain policy, and the static-auth SDK files this origin serves.",
    {
      egress: [
        {
          class: "user-mediated-navigation",
          purpose: "postMessage delivery to a relying site's approved origin",
          automatic: false,
        },
      ],
      offlineLimits:
        "A relying site can only be answered while the upstream broker is reachable.",
    },
  ),
  alwaysOn(
    "backup.git-remote",
    "Git remote backup",
    "Push encrypted vault snapshots to a private repository through the GitHub App or a forge git remote, and sync them back.",
    {
      operationIds: ["backup.status", "backup.target.set"],
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
    "cli.app-integration",
    "CLI integration",
    "Approve OpenSesame CLI requests from this browser while the vault is unlocked (1Password-style terminal sessions).",
    {
      operationIds: ["cli.app_integration.list", "cli.app_integration.respond"],
      egress: [
        {
          class: "peer-or-local-network",
          purpose: CLI_APP_INTEGRATION_PURPOSE,
          automatic: true,
        },
      ],
      browserPermissions: ["webauthn"],
      keyAccess: "protector-wrap",
      offlineLimits:
        "Needs the local daemon on loopback or the tailnet; nothing leaves this device.",
    },
  ),
  alwaysOn(
    "sharing.drops",
    "Secret drops",
    "Share any item's secret once, through a sealed claim. The share is part of that item. Opening a drop someone sent needs nothing else.",
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
          purpose: "the drop link a person copies",
          automatic: false,
        },
      ],
      browserPermissions: ["clipboard-write"],
      keyAccess: "item-plaintext",
      offlineLimits:
        "Creating a share needs the claim host. A share already sent still opens.",
    },
  ),
];
