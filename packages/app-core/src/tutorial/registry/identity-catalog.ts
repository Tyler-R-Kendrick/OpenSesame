/**
 * Targets and routes the `identity.*` capabilities contribute (federation,
 * local IAM, SIOP). Registered as `tutorial-target` and `tutorial-route`
 * contributions on activation; absent on a plan without them.
 */

import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const IDENTITY_TARGETS: readonly GuideTargetDescriptor[] = [
  // ── Identity administration ─────────────────────────────────────────
  {
    id: "identity.agents",
    description:
      "The Agents branch: register proof-bound agents, rename them and revoke registrations you own.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.agent.register",
  },
  {
    id: "identity.people",
    description:
      "The People branch: who you are here, the identities linked to you, the access you hold, and the members of your organizations.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.whoami",
  },
  {
    id: "identity.providers",
    description:
      "The Providers branch: the identity providers registered to vouch for people in this deployment.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },
  {
    id: "identity.devices",
    description:
      "The Devices branch: the tailnet's machines, when a daemon is paired for device management, and the browsers and installs that have unlocked this vault.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.device.approve",
  },
  {
    id: "identity.service-accounts",
    description:
      "The Applications branch: register OIDC clients, manage exact redirect URIs and revoke client registrations.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },
  {
    id: "identity.organization",
    description:
      "The Organizations branch: the organization this session acts in, and its settings.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },
  {
    id: "identity.org-signin",
    description:
      "The Sign-in upstream panel under Organizations: the OIDC issuer or SAML IdP an organization's people sign in through, with its email domains and provisioning tokens below. Only an owner can change them.",
    role: "action",
    routes: ["/identity"],
    capabilityId: "identity.org_signin.upstream.manage",
  },
  {
    id: "identity.register-idp",
    description:
      "Opens the ceremony that registers an identity provider, either from the shipped enterprise presets or as a custom OIDC issuer.",
    role: "ceremony",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },

  {
    id: "nav.identity",
    description:
      "Rail entry that opens Identity, where accounts, upstream providers and linked identities are managed.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
];

export const IDENTITY_ROUTES: readonly GuideRouteDescriptor[] = [
  { id: "/federation", title: "Federation return — finish a sign-in" },
  {
    id: "/identity/authorize",
    title: "Local application — review a sign-in request",
  },
  {
    id: "/identity",
    title: "Identity — accounts, providers and linked identities",
  },
];
