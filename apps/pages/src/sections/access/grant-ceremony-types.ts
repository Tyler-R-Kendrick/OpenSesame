import type { BindingTargetKind, Connection } from "../../lib/connections.js";
import type { SecretItem } from "../../lib/vault/model.js";

export type GrantTarget =
  | { kind: "connection"; connection: Connection }
  | { kind: "secret"; secret: SecretItem };

export type CeremonyStep = "target" | "assign" | "scope" | "mint" | "code";

export const CEREMONY_STEPS: Array<{ id: CeremonyStep; label: string }> = [
  { id: "target", label: "Target" },
  { id: "assign", label: "Who" },
  { id: "scope", label: "Scope" },
  { id: "mint", label: "Review" },
];

/** One identity a grant is meant for. */
export type GrantRecipient = {
  kind: BindingTargetKind;
  id: string;
};

/** Who a grant is meant for. Named identities are bound to the connection;
 * the time-boxed authority still comes only from the claim. */
export type Assignment =
  | { kind: "anyone" }
  | { kind: "bound"; recipients: GrantRecipient[] };

export type ScopeInput = {
  actions: string[];
  resources: string[];
  executionMode: "broker" | "relay";
  expiresInSeconds: number;
};

export type MintedCode = {
  claimToken: string;
  userCode: string;
  expiresAt: string;
  assignment: Assignment;
  /** Set when an identity binding failed after a successful mint. */
  bindWarning: string | null;
};

export function recipientLabel(recipient: GrantRecipient): string {
  return recipient.kind === "identity"
    ? recipient.id
    : `${recipient.kind}:${recipient.id}`;
}

export function assignmentLabel(assignment: Assignment): string {
  if (assignment.kind === "anyone") return "Anyone with the code";
  return assignment.recipients.map(recipientLabel).join(", ");
}

/** Human duration for the review screen — never raw seconds. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(seconds / 86_400);
  return days === 1 ? "1 day" : `${days} days`;
}

export function targetName(target: GrantTarget): string {
  return target.kind === "connection"
    ? target.connection.displayName
    : target.secret.name;
}

export function parseCsv(text: string): string[] {
  return text
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}
