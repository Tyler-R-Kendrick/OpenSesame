/**
 * One target per section of Settings › Capabilities, so a tutorial can point
 * at the section it is about (`feature-goals.ts`). The heading row is the
 * target — the title and its switch — because that is the part of a section
 * a person looks for, and it stays small however many tiles hang under it.
 *
 * Authored prose only: a section's title is a constant of the product, never
 * something a person typed.
 */

import type { GuideTargetDescriptor } from "./targets.js";

export const FEATURE_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "feature.identity",
    description:
      "The Identity section of Settings › Capabilities: who may sign in to this installation. Its switch adds every identity capability this installation can run.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.access",
    description:
      "The Access section of Settings › Capabilities: its switch adds the Access screen — grants, requests, sessions, resources and policies.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.connections",
    description:
      "The Connections section of Settings › Capabilities: its switch adds the Connections screen and the connector bindings under Access.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.directory",
    description:
      "The Directory section of Settings › Capabilities: its switch adds directory provisioning — people, agents and devices, and an organization's own sign-in.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.encryption",
    description:
      "The Encryption section of Settings › Capabilities: the key services this installation can reference. Built in, so it carries no switch.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.certificates",
    description:
      "The Certificate authority section of Settings › Capabilities: its switch adds issuing certificates and keeping them as vault records.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.backups",
    description:
      "The Backups section of Settings › Capabilities: git providers the encrypted vault can back up to. Built in, so it carries no switch.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.password-managers",
    description:
      "The Password managers section of Settings › Capabilities: the managers this installation can connect to. Built in, so it carries no switch.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.cloud-secret-storage",
    description:
      "The Cloud secret storage section of Settings › Capabilities: the cloud secret stores this installation can connect to. Built in, so it carries no switch.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.local-storage",
    description:
      "The Local storage section of Settings › Capabilities: the local stores this installation can connect to. Built in, so it carries no switch.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.item-types",
    description:
      "The Item types section of Settings › Capabilities: its switch adds the built-in kinds beyond a secret and a file, and the passkey and certificate kinds.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.environments",
    description:
      "The Environments section of Settings › Capabilities: its switch adds named sets of values on vault items.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.autofill",
    description:
      "The Browser autofill section of Settings › Capabilities: its switch shows and changes the companion autofill extension on a paired daemon.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.sharing",
    description:
      "The Sharing section of Settings › Capabilities: its switch adds live sessions and household sharing.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.payments",
    description:
      "The Payments section of Settings › Capabilities: its switch adds the Wallet — budgets, payment methods and spending passes.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.ai",
    description:
      "The AI section of Settings › Capabilities: its switch adds the on-device model, the remote support model and WebMCP tools, with the model picks beneath.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.password-reset",
    description:
      "The Password reset section of Settings › Capabilities: its switch adds finding a reset message in a mailbox and running a website's reset ceremony.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.surrogates",
    description:
      "The Surrogate credentials section of Settings › Capabilities: its switch shows and changes the surrogate proxy on a paired daemon.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.networking",
    description:
      "The Networking section of Settings › Capabilities: its switch binds this installation to a tailnet.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.notifications",
    description:
      "The Notifications section of Settings › Capabilities: its switch adds Web Push and notification routing.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "feature.telemetry",
    description:
      "The Telemetry section of Settings › Capabilities: its switch sends anonymous usage and error telemetry to an operator's collector, and is off until chosen.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: null,
  },
];
