/**
 * Optional descriptors — connectors, agents, support, wallet, activity,
 * notifications and telemetry.
 */

import {
  type AuthoredDescriptor,
  optional,
  workerModule,
} from "./descriptor.js";

export const SERVICE_FAMILY_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  optional(
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
  optional(
    "agents.webmcp",
    "WebMCP tools",
    "Register this page's fenced tools with the browser's model context so an in-browser agent can read and navigate it.",
    {
      requiresDocumentReload: true,
    },
  ),
  optional(
    "support.guided-help",
    "Guided help",
    "The support panel, help topics and Driver.js guides that point at authored targets and never act.",
    {
      operationIds: ["client.support", "client.tutorial"],
    },
  ),
  optional(
    "support.local-ai",
    "On-device model",
    "Answer support questions and interpret command-bar utterances with the browser's own Prompt API; choose which plane runs a website's password-reset model.",
    {
      dependencies: ["support.guided-help"],
      operationIds: ["model_plane.choose", "model_plane.read"],
      browserPermissions: ["microphone"],
      offlineLimits: "",
    },
  ),
  optional(
    "support.remote-ai",
    "Remote support model",
    "Send redacted page context to a configured AG-UI endpoint or model provider when the browser has no local model.",
    {
      dependencies: ["support.guided-help"],
      egress: [
        {
          class: "external-service",
          purpose:
            "the configured AG-UI endpoint or model provider, with redacted page context",
          automatic: true,
        },
      ],
      keyAccess: "provider-bearer",
      requiresService: true,
      offlineLimits: "Remote answers are unavailable offline.",
    },
  ),
  optional(
    "wallet.spending",
    "Wallet",
    "Budgets, payment methods and spending passes with a conserved local ledger and agent-facing spending tools.",
    {
      operationIds: [
        "wallet.allocations.read",
        "wallet.budgets.read",
        "wallet.capabilities.read",
        "wallet.lease.request",
        "wallet.lease.request_stop",
        "wallet.lease.status",
        "wallet.payment.execute_approved",
        "wallet.payment.propose",
        "wallet.payment.status",
      ],
      egress: [
        {
          class: "external-service",
          purpose: "a payment issuer or merchant the person explicitly chose",
          automatic: false,
        },
      ],
    },
  ),
  optional(
    "activity.log",
    "Activity log",
    "The durable, sealed trail of consequential events and the Activity section that lists it.",
    {
      keyAccess: "item-plaintext",
    },
  ),
  optional(
    "notifications.web-push",
    "Push notifications",
    "Enrol this installation for Web Push and let the push worker variant show a review doorbell.",
    {
      moduleIds: [workerModule("notifications.web-push")],
      environments: ["document", "service-worker"],
      egress: [
        {
          class: "external-service",
          purpose: "the configured Identity API's push enrolment",
          automatic: false,
        },
      ],
      browserPermissions: ["notifications"],
      requiresService: true,
      workerGraphConstraint: "push",
      offlineLimits: "Enrolment needs the Identity API; delivery is the browser's.",
    },
  ),
  optional(
    "telemetry.external",
    "External telemetry",
    "Send anonymous usage and error telemetry to an operator-configured collector.",
    {
      egress: [
        {
          class: "external-service",
          purpose: "an operator-configured telemetry collector",
          automatic: true,
        },
      ],
      requiresService: true,
      offlineLimits: "Nothing is sent offline; nothing is queued either.",
    },
  ),
];
