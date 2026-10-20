/**
 * One target per section of Settings › Features, so a tutorial can point at
 * the section it is about (`feature-goals.ts`). The heading row is the target
 * — the title and its switch — because that is the part of a section a person
 * looks for, and it stays small however many tiles hang under it. The third
 * party's side of a feature is a section of Settings › Integrations, with its
 * own targets (`integration-catalog.ts`).
 *
 * Scoped to `/settings/features`, not `/settings`: a model is told at most
 * `SUPPORT_LIMITS.maxTargets` controls for the page it is on, and the sections
 * of the page beside this one are not on this one.
 *
 * Authored prose only: a section's title is a constant of the product, never
 * something a person typed.
 */

import type { GuideTargetDescriptor } from "./targets.js";

export const FEATURE_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "feature.identity",
    description:
      "The Identity section of Settings › Features: who may sign in to this installation. Its switch adds every identity capability this installation can run.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.access",
    description:
      "The Access section of Settings › Features: its switch adds the Access screen — grants, requests, sessions, resources and policies.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.connections",
    description:
      "The Connections section of Settings › Features: its switch adds the Connections screen and the connector bindings under Access.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.directory",
    description:
      "The Directory section of Settings › Features: its switch adds directory provisioning — people, agents and devices, and an organization's own sign-in.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.certificates",
    description:
      "The Certificate authority section of Settings › Features: certificate administration, which an operator's plan can approve. It has no switch unless a plan already approves it.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.encrypted-search",
    description:
      "The Encrypted search section of Settings › Features: its switch keeps the history-backup and retired-password databases encrypted with no readable name, id or field, and searchable by blind index.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.item-types",
    description:
      "The Item types section of Settings › Features: its switch adds the built-in kinds beyond a secret and a file, and the passkey and certificate kinds.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.environments",
    description:
      "The Environments section of Settings › Features: its switch adds an Environments key to the vault, where every standalone secret starts as a key, holds a sealed value for each named environment, and generates a .env.<name>.schema for each.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.security-checks",
    description:
      "Settings › Features › Breach and two-step checks: its switch runs breach and two-step checks on vault logins.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.autofill",
    description:
      "The Browser autofill section of Settings › Features: its switch shows and changes the companion autofill extension on a paired daemon.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.sharing",
    description:
      "The Sharing section of Settings › Features: its switch adds live sessions and trusted contacts.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.payments",
    description:
      "The Payments section of Settings › Features: its switch adds the Wallet — budgets, payment methods and spending passes.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.ai",
    description:
      "The AI section of Settings › Features: its switch adds the on-device model, the remote support model and WebMCP tools.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.password-reset",
    description:
      "The Password reset section of Settings › Features: its switch adds email accounts as vault items, a mailbox choice on each login, and checking those mailboxes for a reset message to start a website's reset ceremony.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.surrogates",
    description:
      "The Surrogate credentials section of Settings › Features: its switch shows and changes the surrogate proxy on a paired daemon.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.networking",
    description:
      "The Networking section of Settings › Features: its switch binds this installation to a tailnet.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.notifications",
    description:
      "The Notifications section of Settings › Features: its switch adds Web Push and notification routing.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.local-notifications",
    description:
      "The Local notifications section of Settings › Features: its switch adds this device's own requests list, bell and system notifications.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.telemetry",
    description:
      "The Telemetry section of Settings › Features: anonymous usage and error telemetry to an operator's collector, off until chosen. It has no switch unless a plan already approves it.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
];
