/**
 * Optional descriptors — the servers family: this device as an identity
 * host (browser-local IAM, SIOP, the site broker) and the enterprise
 * directory and certificate authority.
 */

import { type AuthoredDescriptor, optional } from "./descriptor.js";

const IDENTITY_API_EGRESS = {
  class: "external-service",
  purpose: "the configured Identity API",
  automatic: false,
} as const;

export const IDENTITY_FAMILY_DESCRIPTORS: readonly AuthoredDescriptor[] = [
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
