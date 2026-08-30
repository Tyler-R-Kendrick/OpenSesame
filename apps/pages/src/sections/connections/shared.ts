/**
 * Pure helpers shared by the Connections list and connector pages.
 * No React, no fetching — everything here is unit-testable in isolation.
 */

import { ConnectionsError } from "../../lib/connections.js";
import type {
  Connection,
  Provider,
  ProviderCategory,
} from "../../lib/connections.js";
import { VERB_CHIP, VERB_LABEL } from "../../lib/identity-graph.js";
import { HostSessionError } from "../../lib/identity.js";

export type Flash = { tone: "ok" | "warn" | "err"; text: string };

export type LoadFailure = {
  message: string;
  unreachable: boolean;
  setupRequired?: boolean;
};

export const CATEGORY_LABELS = {
  custom: "Custom connectors",
  encryption: "Encryption (secrets in git)",
  cloud_secret_storage: "Cloud secret storage",
  password_managers: "Password managers",
  local_storage: "Local storage",
  developer: "Developer tools",
  productivity: "Productivity",
  communication: "Communication",
  storage: "Storage",
  crm: "CRM",
  payments: "Payments",
  identity: "Identity",
  testing: "Testing",
} satisfies Record<ProviderCategory, string>;

export const CATEGORY_ORDER: ProviderCategory[] = [
  "custom",
  "encryption",
  "cloud_secret_storage",
  "password_managers",
  "local_storage",
  "developer",
  "productivity",
  "communication",
  "storage",
  "crm",
  "payments",
  "identity",
  "testing",
];

export function connectorPath(
  providerId: string,
  connectionId?: string,
): string {
  const provider = encodeURIComponent(providerId);
  return connectionId
    ? `/connections/${provider}/${encodeURIComponent(connectionId)}`
    : `/connections/${provider}`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : timeFormat.format(at);
}

/** "in 12 minutes" / "3 days ago", for horizons the user has to reason about. */
export function relative(iso: string | null): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const seconds = Math.round((at - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];
  let value = seconds;
  for (const [unit, span] of units) {
    if (Math.abs(value) < span) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
        value,
        unit,
      );
    }
    value = Math.round(value / span);
  }
  return null;
}

export function errorText<Thrown>(error: Thrown): string {
  if (error instanceof HostSessionError) {
    if (error.code === "setup_required") {
      return `${error.message} Connect on Identity first so this page can mint a Host session, then try again.`;
    }
    return error.message;
  }
  if (error instanceof ConnectionsError) {
    if (
      error.code === "exchange_failed" &&
      /bad credentials|401|unauthorized/i.test(error.message)
    ) {
      return "GitHub rejected that token. Use a classic PAT (ghp_…) or fine-grained token with Contents: Read and Write on the store repo (repo scope).";
    }
    if (error.code === "provider_unconfigured") {
      return "OAuth App credentials are not set on this Host. Paste a personal access token instead — no OAuth App required.";
    }
    if (error.code === "integration_not_found") {
      return "Host could not open this connector yet. Reload Connections after Identity is connected, or paste a GitHub PAT on the connector page.";
    }
    return error.message;
  }
  // Zod dumps every issue as JSON — one bad field across the catalog becomes
  // dozens of "error lines" in the banner. Never render that wall.
  if (
    error instanceof Error &&
    "issues" in error &&
    Array.isArray(error.issues)
  ) {
    return "Host returned data this page does not understand. Try Reload, or pair Host again from Settings.";
  }
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.startsWith("[") || message.includes('"code":')) {
      return "Host returned data this page does not understand. Try Reload, or pair Host again from Settings.";
    }
    return message;
  }
  return "Something went wrong.";
}

export const STATUS_CHIP = {
  pending: { tone: VERB_CHIP.needs_you, label: VERB_LABEL.needs_you },
  active: { tone: VERB_CHIP.connected, label: VERB_LABEL.connected },
  needs_reauth: { tone: VERB_CHIP.needs_you, label: VERB_LABEL.needs_you },
  expired: { tone: VERB_CHIP.needs_you, label: VERB_LABEL.needs_you },
  revoked: { tone: VERB_CHIP.idle, label: "Revoked" },
  error: { tone: VERB_CHIP.broken, label: VERB_LABEL.broken },
} satisfies Record<Connection["status"], { tone: string; label: string }>;

/** One sentence answering "is this working, and do I have to do anything?". */
export function statusSentence(
  connection: Connection,
  provider?: Provider | null,
): string {
  const who = connection.accountLabel ? ` as ${connection.accountLabel}` : "";
  switch (connection.status) {
    case "pending":
      return "Created, but nobody has approved it yet. Authorize it to finish.";
    case "active": {
      if (provider?.authKind === "configuration") {
        return "Configuration saved on this Host and ready to bind to a project or agent.";
      }
      if (provider?.authKind === "api_key") {
        return `Credential stored${who}. It does not expire automatically.`;
      }
      const expiry = relative(connection.expiresAt);
      if (connection.refreshable) {
        return expiry
          ? `Authorized${who}. The access token expires ${expiry} and renews itself.`
          : `Authorized${who}. Renews itself; no further sign-in needed.`;
      }
      return expiry
        ? `Authorized${who}. This provider issues no refresh token, so it expires ${expiry} for good.`
        : `Authorized${who}. This provider issues a long-lived token with no refresh.`;
    }
    case "needs_reauth":
      return (
        connection.statusDetail ??
        "Renewal was refused by the provider. Authorize it again to restore it."
      );
    case "expired":
      return "The access token expired and there is no refresh token to renew it.";
    case "revoked":
      return "Revoked here. Its bindings and history are kept for the record.";
    case "error":
      return connection.statusDetail ?? "The provider returned an error.";
  }
}
