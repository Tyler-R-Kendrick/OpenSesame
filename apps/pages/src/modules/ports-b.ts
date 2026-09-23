/**
 * The WebMCP tagging helpers the wave-B runtimes share.
 *
 * Three "optional ports" used to live here, each one something the loader
 * was "asked to add" and nothing ever added, so every module that used one
 * read `undefined` and its surface simply never appeared: approving guided
 * help drew no Support key, approving agent tools mounted no registrar,
 * approving the interoperability formats added no panel, and
 * `opensesame_navigate` answered `router_unavailable` on every call. Two are
 * contribution kinds now (`shell-wrapper`, `settings-panel`), registered
 * through `activation.register`; `navigate` is on the context itself. All
 * four fail loudly rather than optionally.
 *
 * Also here: the tag every `webmcp-tool` contribution carries so the core
 * (and the surface's own job) can filter by `approvedOperations`
 * (SURFACE-05). An entry without `operationIds` is never registered.
 */

import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import type { PagesWebMcpTool } from "@opensesame/app-core/webmcp/tool-shared.js";
import type { RegistrationHandle } from "@opensesame/capability-composition";
import type { ComponentType, ReactNode } from "react";

/** Kept as the name the wave-B runtimes import; the contract carries it all now. */
export type ContextWithPorts = ApprovedCapabilityContext;

/** A tool spec carrying the operation ids its dispatch is gated on. */
export type TaggedWebMcpTool = PagesWebMcpTool & {
  readonly operationId: string;
  readonly operationIds: readonly string[];
};

export function tagWebMcpTool(tool: PagesWebMcpTool): TaggedWebMcpTool {
  const [operationId] = tool.capabilityIds;
  if (!operationId) {
    throw new Error(`webmcp tool without an operation id: ${tool.name}`);
  }
  return { ...tool, operationId, operationIds: tool.capabilityIds };
}

/** The operation ids a contributed entry was tagged with, or null when untagged. */
export function readOperationIds(entry: object): readonly string[] | null {
  if (!("operationIds" in entry)) return null;
  const value = entry.operationIds;
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string") return null;
    ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}
