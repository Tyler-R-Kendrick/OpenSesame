/**
 * The authority a WebMCP tool call needs, taken inside the execute wrapper
 * before the tool's own handler runs (ownership.md §4.2).
 *
 * Registration decided which tools the browser was *offered*; this decides
 * whether a call made now may proceed. An agent can hold a tool it listed
 * before a lock, an emergency disable or a plan change, so the call resolves
 * the tool's live registration again and refuses — `CapabilityDenied`, and
 * the handler never runs — unless:
 *
 * - the tool names an owning operation (its first tagged id);
 * - a registration of this generation holds it under a current lease, and
 *   the plan approves that operation (`assertCurrentOperationAuthority`);
 * - and, for a tool not declared read-only, every other tab agrees: the
 *   durable generation matches and Web Locks serialize the check
 *   (`admitOperation`). A read-only lookup skips only this last step.
 */

import {
  admitSensitiveOperation,
  assertToolAuthority,
} from "@opensesame/app-core/lib/capabilities/dispatch.js";
import { CapabilityDenied } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import { readOperationIds } from "../ports-b.js";

function ownerOf(tool: WebMcpToolSpec): string | null {
  return readOperationIds(tool)?.[0] ?? null;
}

/** A tool not declared read-only changes something; it is admitted across tabs. */
export function isSensitiveTool(tool: WebMcpToolSpec): boolean {
  return tool.readOnly !== true;
}

/** Throw `CapabilityDenied` unless `tool` may run now. */
export async function authorizeToolCall(tool: WebMcpToolSpec): Promise<void> {
  const operation = ownerOf(tool);
  if (operation === null)
    throw new CapabilityDenied("NOT_REGISTERED", tool.name);
  const lease = assertToolAuthority(tool.name, operation, ownerOf);
  if (isSensitiveTool(tool)) await admitSensitiveOperation(operation, lease);
}
