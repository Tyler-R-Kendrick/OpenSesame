/**
 * Optional descriptors — access, identity and enterprise families.
 */

import { type AuthoredDescriptor, optional } from "./descriptor.js";

const IDENTITY_API_EGRESS = {
  class: "external-service",
  purpose: "the configured Identity API",
  automatic: false,
} as const;

export const IDENTITY_FAMILY_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  optional(
    "access.authority",
    "Access authority",
    "The Access section: local grants, requests, sessions, resources and policies, plus Host-plane tasks, delegations, relay approvals, receipts and pairing when a Host is configured.",
    {
      operationIds: [
        "agent.runs.control",
        "agent.runs.observe",
        "agent.runs.read",
        "agent_identities.read",
        "authority.portal.templates.manage",
        "authority.portal.templates.read",
        "browser.client.revoke",
        "browser.identity.authenticate",
        "browser.pairing.begin",
        "changelog.read",
        "configs.browse",
        "configs.permissions.read",
        "configs.set",
        "daemon.status",
        "delegations.claim",
        "delegations.list",
        "delegations.narrow",
        "delegations.offers.list",
        "delegations.offers.mint",
        "delegations.offers.revoke",
        "delegations.revoke",
        "host.health",
        "host.health.pages",
        "host.whoami",
        "identity.approval.activation",
        "identity.approval.comparison",
        "identity.approval.requests",
        "identity.local.access.manage",
        "identity.local.policy.manage",
        "identity.local.requests.manage",
        "receipts.read",
        "relay.decide",
        "relay.inbox",
        "shared_sessions.join_request",
        "tasks.inspect",
        "tasks.list",
        "tasks.start",
        "tasks.terminate",
        "transport.capabilities.discover",
        "transport.identity.reference",
        "transport.status.view",
        "transport.verify.run",
      ],
      egress: [
        {
          class: "external-service",
          purpose: "the configured Host API and Identity API",
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
  optional(
    "identity.federation",
    "Operator identity providers",
    "Sign in through operator-registered OpenID providers, bring-your-own issuers and the Identity API's directory: the Providers tab, the setup identity and MFA tabs.",
    {
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
  optional(
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
  optional(
    "identity.local-iam",
    "Browser-local IAM",
    "This device as an identity host: the local directory of people, agents, devices and applications, local passkeys, application sign-in and grants.",
    {
      operationIds: [
        "identity.local.agent.keys.manage",
        "identity.local.application.authorize",
        "identity.local.directory.manage",
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
  optional(
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
  optional(
    "enterprise.directory-provisioning",
    "Directory provisioning",
    "Manage people, agents and devices in the Identity API's directory: users, agent registration, device approval and admin reads.",
    {
      dependencies: ["identity.federation"],
      operationIds: [
        "identity.admin",
        "identity.agent.manage",
        "identity.agent.register",
        "identity.device.approve",
        "identity.users.manage",
      ],
      egress: [IDENTITY_API_EGRESS],
      requiresService: true,
      offlineLimits: "Every directory change needs the Identity API.",
    },
  ),
  optional(
    "enterprise.ca-administration",
    "Certificate authority",
    "Issue certificates from the Host's authority and keep them as certificate records.",
    {
      dependencies: ["vault.certificate-records", "access.authority"],
      operationIds: ["certs.issue"],
      egress: [
        {
          class: "external-service",
          purpose: "the configured Host API's certificate routes",
          automatic: false,
        },
      ],
      requiresService: true,
      offlineLimits: "Issuance needs the Host; issued records still list.",
    },
  ),
];
