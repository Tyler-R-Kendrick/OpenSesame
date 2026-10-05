/**
 * Optional descriptors — AI (agents and models), payments, networking,
 * notifications and telemetry.
 */

import {
  type AuthoredDescriptor,
  optional,
  workerModule,
} from "./descriptor.js";

/**
 * What `notifications.web-push` declares for its external-service egress.
 * Egress classifies a request by the purpose it names, exactly, so the
 * enrolment code imports this rather than retype it: a retyped copy that
 * drifted refused every enrolment as `purpose-not-declared`.
 */
export const WEB_PUSH_ENROLMENT_PURPOSE =
  "the configured Identity API's push enrolment";

/**
 * What `networking.tailnet-devices` declares for the daemon it manages the
 * tailnet through; the client imports it so the two can never drift.
 */
export const TAILNET_DEVICES_PURPOSE =
  "the daemon a person paired for tailnet device management, which holds the Tailscale credential";

export const SERVICE_FAMILY_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  optional(
    "agents.webmcp",
    "WebMCP tools",
    "Register this page's fenced tools with the browser's model context so an in-browser agent can read and navigate it.",
    // Starts in place: `registerTool` may be called at any time, and
    // `verify:webmcp` chooses it after boot and reads four native tools
    // without a reload. Declaring a reload here would hold it back for one
    // (RELOAD_REQUIRED) that it does not need.
    {},
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
    "ai.password-reset",
    "Password reset",
    "Find a password-reset message in a configured mailbox and run the website password-reset ceremony for that login.",
    { dependencies: ["vault.derived-records"] },
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
    "notifications.local",
    "Local notifications",
    "Tell you that a request is waiting while the app is open or in the background: a mark on the bell and the tab, and a system notification if you allow one. Nothing leaves this device.",
    {
      // The requests it tells you about are the ones Browser-local IAM
      // serves; with it off there is nothing to be told.
      dependencies: ["identity.local-iam"],
      operationIds: ["identity.notification.local.manage"],
      // Asked for on a key in its panel, never on activation.
      browserPermissions: ["notifications"],
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
          purpose: WEB_PUSH_ENROLMENT_PURPOSE,
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
    "notifications.routing",
    "Notification routing",
    "Choose where the Identity API tells you about requests: its channels, the destinations you connect, and the order each kind of prompt tries them. Where you are told never changes what it takes to approve.",
    {
      operationIds: [
        "identity.notification.bindings.manage",
        "identity.notification.channels.read",
        "identity.notification.preferences.manage",
      ],
      egress: [
        {
          class: "external-service",
          purpose:
            "the configured Identity API's channels, destinations and notification preferences",
          automatic: false,
        },
      ],
      requiresService: true,
      offlineLimits:
        "Reading or changing where you are told needs the Identity API; requests still wait in the inbox.",
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
      operationIds: ["vault.drive.sync", "plugins.pair", "plugins.unpair"],
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
  optional(
    "networking.tailnet-devices",
    "Tailnet devices",
    "Manage the tailnet's real machines from Identity › Devices: approve, rename, tag, re-key, route and remove them, and add one with an auth key. The paired daemon holds the Tailscale credential and makes every call (ADR 0167).",
    {
      dependencies: ["networking.tailnet", "identity.local-iam"],
      operationIds: [
        "tailnet.devices.pair",
        "tailnet.devices.read",
        "tailnet.devices.manage",
        "tailnet.keys.manage",
        "tailnet.audit.read",
      ],
      egress: [
        {
          class: "peer-or-local-network",
          purpose: TAILNET_DEVICES_PURPOSE,
          automatic: false,
        },
      ],
      requiresService: true,
      offlineLimits:
        "Devices are read from the paired daemon; offline the list is not shown and nothing can be changed.",
    },
  ),
];
