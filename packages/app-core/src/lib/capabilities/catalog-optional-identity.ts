/**
 * Optional descriptors — the enterprise directory and certificate authority,
 * the two that need a server someone runs (the Identity API, the Host). This
 * device as an identity host (browser-local IAM, SIOP, the site broker) is
 * always on (`catalog-always-on-local.ts`, ADR 0142).
 */

import { type AuthoredDescriptor, optional } from "./descriptor.js";

const IDENTITY_API_EGRESS = {
  class: "external-service",
  purpose: "the configured Identity API",
  automatic: false,
} as const;

export const IDENTITY_FAMILY_DESCRIPTORS: readonly AuthoredDescriptor[] = [
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
