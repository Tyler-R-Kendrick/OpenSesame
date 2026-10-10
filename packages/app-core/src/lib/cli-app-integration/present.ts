import { cliAppIntegrationPolicy } from "./policy.js";
import type { PendingRequest } from "./session.js";

const ui = cliAppIntegrationPolicy.ui;
const verbLabels = cliAppIntegrationPolicy.verbLabels;

export type CliAuthorizeView = Readonly<{
  requestId: string;
  terminalSessionId: string;
  terminalLabel: string;
  commandLabel: string;
  targetLine: string | null;
  fieldLine: string | null;
}>;

/** Short, human label for a hashed terminal session id (1Password-style). */
export function terminalSessionLabel(terminalSessionId: string): string {
  const trimmed = terminalSessionId.trim();
  if (!trimmed) return "Unknown terminal";
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

function verbLabel(verb: string): string {
  const row = verbLabels[verb as keyof typeof verbLabels];
  return row ?? verb;
}

function parseReference(reference: string | undefined): {
  target: string | null;
  field: string | null;
} {
  if (!reference?.trim()) return { target: null, field: null };
  const raw = reference.trim();
  const opMatch = /^op:\/\/([^/]+)\/(.+)$/i.exec(raw);
  if (opMatch) {
    const rest = opMatch[2];
    const slash = rest.lastIndexOf("/");
    if (slash >= 0) {
      return {
        target: `${opMatch[1]}/${rest.slice(0, slash)}`,
        field: rest.slice(slash + 1),
      };
    }
    return { target: `${opMatch[1]}/${rest}`, field: null };
  }
  const colon = raw.indexOf(":");
  if (colon > 0) {
    return { target: raw.slice(0, colon), field: raw.slice(colon + 1) };
  }
  return { target: raw, field: null };
}

export function presentCliAuthorizeRequest(
  row: PendingRequest,
): CliAuthorizeView {
  const { target, field } = parseReference(row.reference);
  return {
    requestId: row.requestId,
    terminalSessionId: row.terminalSessionId,
    terminalLabel: terminalSessionLabel(row.terminalSessionId),
    commandLabel: verbLabel(row.verb),
    targetLine: target,
    fieldLine: field,
  };
}

export function cliAuthorizeCopy() {
  return ui;
}
