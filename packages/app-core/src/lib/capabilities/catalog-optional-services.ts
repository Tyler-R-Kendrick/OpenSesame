/**
 * Optional descriptors — AI (agents and models), payments, networking,
 * notifications and telemetry.
 */

import {
  type AuthoredDescriptor,
  optional,
  workerModule,
} from "./descriptor.js";

export const SERVICE_FAMILY_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  optional(
    "agents.webmcp",
    "WebMCP tools",
    "Register this page's fenced tools with the browser's model context so an in-browser agent can read and navigate it.",
    {
      requiresDocumentReload: true,
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
      offlineLimits:
        "Enrolment needs the Identity API; delivery is the browser's.",
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
  optional(
    "networking.tailnet",
    "Tailnet networking",
    "Bind this installation to a Tailscale tailnet: the networking connectors, the tailnet a daemon is reached over, and syncing the vault through a drive on it.",
    {
      operationIds: ["vault.drive.sync"],
      egress: [
        {
          class: "peer-or-local-network",
          purpose: "a daemon reached over the tailnet a person configured",
          automatic: false,
        },
        {
          class: "peer-or-local-network",
          purpose:
            "the vault drive a person paired, which only ever receives the sealed vault",
          automatic: true,
        },
      ],
      requiresService: true,
      offlineLimits:
        "A tailnet peer is reachable only while the tailnet is up; edits made offline sync on the next pass.",
    },
  ),
];
