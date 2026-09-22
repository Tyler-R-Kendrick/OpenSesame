/**
 * Ports the wave-B runtimes need that ownership.md §4.3 does not yet name.
 * Each is optional on the context: a module reads it when the loader hands
 * it over and does without it otherwise, and never reaches around the
 * context to get the same effect. The loader (S06) is asked to add them:
 *
 * - `navigate` — the router's navigate, for `agents.webmcp`'s boot tools.
 *   Without it the navigation seam keeps its throwing default
 *   (`router_unavailable`), which is what the tools reported before.
 * - `registerShellWrapper` — a component that wraps the shell body (a React
 *   provider and its launcher). `support.guided-help` needs it for
 *   `SupportProvider`; a contribution kind `shell-wrapper` would be the
 *   proper home. Without it the support panel is not mounted.
 * - `registerSettingsPanel` — a panel under an existing Settings category
 *   (`identity.ambient-sso`'s returning-user opt-in lives under Security).
 *   Without it the panel is not shown; the preference itself still applies.
 *
 * Also here: the tag every `webmcp-tool` contribution carries so the core
 * (and the surface's own job) can filter by `approvedOperations`
 * (SURFACE-05). An entry without `operationIds` is never registered.
 */

import type { RegistrationHandle } from "@opensesame/capability-composition";
import type { ComponentType, ReactNode } from "react";
import type { ApprovedCapabilityContext } from "../lib/capabilities/runtime-contract.js";
import type { PagesWebMcpTool } from "../webmcp/tool-shared.js";

export type ShellWrapperContribution = Readonly<{
  id: string;
  Wrapper: ComponentType<{ children?: ReactNode }>;
  order: number;
}>;

export type SettingsPanelContribution = Readonly<{
  id: string;
  /** An existing Settings category id, e.g. "security". */
  category: string;
  Panel: ComponentType;
  order: number;
}>;

export type OptionalPorts = Readonly<{
  navigate: (to: string) => void;
  registerShellWrapper: (entry: ShellWrapperContribution) => RegistrationHandle;
  registerSettingsPanel: (
    entry: SettingsPanelContribution,
  ) => RegistrationHandle;
}>;

/** The context as the wave-B runtimes read it: the contract plus optional ports. */
export type ContextWithPorts = ApprovedCapabilityContext & Partial<OptionalPorts>;

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
