/**
 * One target per section of Settings › Integrations, so a tutorial can point
 * at the section it is about (`integration-goals.ts`). An integration is a
 * third party a feature connects to, configured by reference on the
 * connector's own page, so unlike a feature section it carries no switch. The
 * heading row is the target, and it stays small however many tiles hang under
 * it. The switches are sections of Settings › Features
 * (`feature-catalog.ts`).
 *
 * Scoped to `/settings/integrations`, not `/settings`, for the same reason as
 * the feature sections: the model's per-page target budget.
 *
 * Authored prose only: a section's title is a constant of the product, never
 * something a person typed.
 */

import type { GuideTargetDescriptor } from "./targets.js";

export const INTEGRATION_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "integration.services",
    description:
      "The Services section of Settings › Integrations: developer APIs, productivity, communication, storage and CRM providers, each opening its own supported configuration page.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.identity",
    description:
      "The Identity section of Settings › Integrations: the identity providers that can sign people in beside browser-local identity, each opening its own page.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.encryption",
    description:
      "The Encryption section of Settings › Integrations: the key services this installation can reference — a cloud key service, a hardware key, an age recipient — each configured by reference.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.certificates",
    description:
      "The Certificate authority section of Settings › Integrations: the authorities this installation can connect to, each by reference.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.backups",
    description:
      "The Backups section of Settings › Integrations: the git providers the encrypted vault can back up to.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.password-managers",
    description:
      "The Password managers section of Settings › Integrations: the managers this installation can connect to, each by reference.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.cloud-secret-storage",
    description:
      "The Cloud secret storage section of Settings › Integrations: the cloud secret stores this installation can connect to, each by reference.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.payments",
    description:
      "The Payments section of Settings › Integrations: the card issuers and wallet-pass providers the Wallet can connect to, each by reference.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.password-reset",
    description:
      "The Password reset section of Settings › Integrations: computer-use runtimes such as Vercel Sandbox, E2B and Browserbase CDP, each configured by reference. Model providers are in AI.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.ai",
    description:
      "The AI section of Settings › Integrations: connect agent harnesses and AI model providers. Voice and inference model choices are in Settings › Features › AI.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.networking",
    description:
      "The Networking section of Settings › Integrations: the tailnet providers this installation can reach, each by reference.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
];
