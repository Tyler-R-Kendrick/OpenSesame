import type { GuideTargetDescriptor } from "./targets.js";
export const IDENTITY_TARGETS: readonly GuideTargetDescriptor[] = [
  // ── Identity administration ─────────────────────────────────────────
  {
    id: "identity.agents",
    description:
      "The Agents tab: register proof-bound agents, rename them and revoke registrations you own.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.agent.register",
  },
  {
    id: "identity.people",
    description:
      "The People tab: who you are here, the identities linked to you, the access you hold, and the members of your organizations.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.whoami",
  },
  {
    id: "identity.providers",
    description:
      "The Providers tab: the identity providers registered to vouch for people in this deployment.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },
  {
    id: "identity.devices",
    description:
      "The Devices tab: device sign-ins waiting for approval, and the devices already trusted.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.device.approve",
  },
  {
    id: "identity.service-accounts",
    description:
      "The Applications tab: register OIDC clients, manage exact redirect URIs and revoke client registrations.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },
  {
    id: "identity.organization",
    description:
      "The Organization tab: the organization this session acts in, and its settings.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },
  {
    id: "identity.register-idp",
    description:
      "Opens the ceremony that registers an identity provider, either from the shipped enterprise presets or as a custom OIDC issuer.",
    role: "ceremony",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },
];
