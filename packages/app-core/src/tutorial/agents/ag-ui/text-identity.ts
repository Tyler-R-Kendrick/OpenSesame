import { type JsonObject, readString } from "@opensesame/os-domain";
import { SupportError } from "@opensesame/support-agent";

const MAX_TRACKED_MESSAGES = 256;

/**
 * Named messages with an observed non-assistant role remain suppressed.
 * An ID-less, role-less chunk cannot be associated with a named message and
 * remains accepted for compatibility with the existing protocol.
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
