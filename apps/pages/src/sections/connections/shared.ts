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

export type Flash = { tone: "ok" | "warn" | "err"; text: string };

export type LoadFailure = {
  message: string;
  unreachable: boolean;
  setupRequired?: boolean;
};

export const CATEGORY_LABELS = {
  identity: "Identity",
  backup_recovery: "Backup/recovery",
  encryption: "Encryption (secrets in git)",
  password_managers: "Password managers",
  agent_harnesses: "Agent harnesses",
  networking: "Networking",
  wallet: "Wallet",
  custom: "Custom connectors",
  cloud_secret_storage: "Cloud secret storage",
  local_storage: "Local storage",
  certificates: "Certificates",
  developer: "Developer tools",
  productivity: "Productivity",
  communication: "Communication",
  storage: "Storage",
  crm: "CRM",
  testing: "Testing",
} satisfies Record<ProviderCategory, string>;

/** Capability families bound in Settings, not connectors shared through IAM. */
export const FEATURE_BINDING_CATEGORIES = [
  "identity",
  "backup_recovery",
  "encryption",
  "password_managers",
  "agent_harnesses",
  "networking",
  "wallet",
  "cloud_secret_storage",
  "local_storage",
  "certificates",
] as const satisfies readonly ProviderCategory[];

const FEATURE_BINDING_SET = new Set<ProviderCategory>(
  FEATURE_BINDING_CATEGORIES,
);

export function isFeatureBindingCategory(category: ProviderCategory): boolean {
  return FEATURE_BINDING_SET.has(category);
}

export const CATEGORY_ORDER: ProviderCategory[] = [
  "identity",
  "backup_recovery",
  "encryption",
  "password_managers",
  "agent_harnesses",
  "networking",
  "wallet",
  "custom",
  "cloud_secret_storage",
  "local_storage",
  "certificates",
  "developer",
  "productivity",
  "communication",
  "storage",
  "crm",
  "testing",
];

/** SPA root for a connector ceremony — catalog vs Settings → Connections. */
export type ConnectorCeremonyRoot = "/connections" | "/settings/connections";

export function connectorCeremonyRoot(pathname: string): ConnectorCeremonyRoot {
  return pathname.startsWith("/settings/connections")
    ? "/settings/connections"
    : "/connections";
}

export function connectorPath(
  providerId: string,
  connectionId?: string,
  root: ConnectorCeremonyRoot = "/connections",
): string {
  const provider = encodeURIComponent(providerId);
  const base = `${root}/${provider}`;
  return connectionId ? `${base}/${encodeURIComponent(connectionId)}` : base;
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
  if (error instanceof ConnectionsError) {
    if (
      error.code === "exchange_failed" &&
      /bad credentials|401|unauthorized/i.test(error.message)
    ) {
      return "GitHub rejected that token. Use a classic PAT (ghp_…) or fine-grained token with Contents: Read and Write on the store repo (repo scope).";
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
    return "The response could not be read. Try Reload.";
  }
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.startsWith("[") || message.includes('"code":')) {
      return "Connect returned data this page does not understand. Try Reload.";
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
function gitStatusSentence(connection: Connection): string {
  return connection.accountLabel
    ? `Remote ${connection.accountLabel}.`
    : "Git remote configured.";
}

export function statusSentence(
  connection: Connection,
  provider?: Provider | null,
): string {
  const who = connection.accountLabel ? ` as ${connection.accountLabel}` : "";
  switch (connection.status) {
    case "pending":
      return "Created, but nobody has approved it yet. Authorize it to finish.";
    case "active": {
      if (provider?.id === "git") return gitStatusSentence(connection);
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
