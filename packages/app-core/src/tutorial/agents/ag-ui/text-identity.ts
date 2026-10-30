import { type JsonObject, readString } from "@opensesame/os-domain";
import { SupportError } from "@opensesame/support-agent";

const MAX_TRACKED_MESSAGES = 256;

/**
 * Which open message ids are assistant text. A `TEXT_MESSAGE_START` that
 * declares any other role opens a message whose deltas are dropped — a server
 * cannot smuggle a "system" or "tool" message into the answer by streaming it
 * as text.
 */
export type MessageRoles = Map<string, boolean>;

/** Preserve the text identity checks previously applied by the AG-UI decoder. */
export function validateTextIdentity(
  event: JsonObject,
  idRequired: boolean,
): void {
  const id = readString(event.messageId);
  const role = readString(event.role);
  if (
    (idRequired && id === undefined) ||
    (event.messageId !== undefined && id === undefined) ||
    (event.role !== undefined &&
      (role === undefined ||
        !["assistant", "developer", "system", "user"].includes(role)))
  ) {
    throw new SupportError(
      "AGENT_PROTOCOL_ERROR",
      "the support endpoint sent an invalid text identity",
    );
  }
}

export function acceptsDelta(roles: MessageRoles, event: JsonObject): boolean {
  const role = readString(event.role);
  if (role !== undefined && role !== "assistant") return false;
  const id = readString(event.messageId);
  if (id === undefined) return true;
  if (!roles.has(id) && roles.size >= MAX_TRACKED_MESSAGES) return false;
  return roles.get(id) !== false;
}

export function rememberRole(roles: MessageRoles, event: JsonObject): void {
  const id = readString(event.messageId);
  if (id === undefined) return;
  if (!roles.has(id) && roles.size >= MAX_TRACKED_MESSAGES) return;
  const role = readString(event.role);
  roles.set(
    id,
    roles.get(id) !== false && (role === undefined || role === "assistant"),
  );
}
