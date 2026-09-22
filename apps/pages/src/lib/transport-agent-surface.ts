/**
 * What an agent may see of transport (UI-AGENTS): a read-only view of the
 * status this tab has already read, and nothing that could register a trust
 * root, move custody, reveal a key, provision a native source or widen a
 * service binding. Those stay human/operator ceremonies.
 *
 * The one tool is a *view*. It never fetches — an agent that could make the
 * page probe an endpoint would have an egress oracle — and it carries names
 * and outcomes only, never an address, a path or a PEM.
 */
import { CAPABILITIES } from "@opensesame/capability-registry";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import { transportCapabilities } from "./transport-capabilities.js";
import { toTransportViewState } from "./transport-rows.js";
import { lastTransportStatus } from "./transport-status.js";

export const TRANSPORT_STATUS_VIEW_TOOL = "opensesame_transport_status_view";

/** Names an agent transport tool must never carry. */
export const TRANSPORT_FORBIDDEN_TOOL_PATTERN =
  /trust|custody|key|provision|csr|import|export|reveal|install|sign|probe|verify|bind|rotate|revoke|enroll/i;

export type TransportAgentTool = WebMcpToolSpec & {
  capabilityIds: readonly string[];
  scope: "boot" | "session";
};

/** The agent projection: the five rows, staleness, browser capabilities. */
export function transportStatusForAgent() {
  const last = lastTransportStatus();
  const view = toTransportViewState(last, "existing_local");
  return {
    status: last === null ? "not_checked" : last.kind,
    target: view.target,
    stale: view.stale,
    rows: view.rows
      .filter((row) => row.id !== "desired")
      .map((row) => ({ dimension: row.id, tone: row.tone, state: row.state })),
    browser: transportCapabilities(),
  };
}

/** The one candidate. It ships only where the registry maps it (below). */
export const TRANSPORT_STATUS_VIEW_CANDIDATE: TransportAgentTool = {
  name: TRANSPORT_STATUS_VIEW_TOOL,
  capabilityIds: ["transport.status.view"],
  scope: "session",
  readOnly: true,
  description:
    "Transport status this tab last read: credential, runtime, observed authentication and enforcement, each as a separate outcome, plus what a browser can and cannot do. Never fetches, never names an address, never carries key material.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute: () => transportStatusForAgent(),
};

/** A capability the registry maps onto WebMCP for the Pages surface. */
function webmcpMapped(id: string): boolean {
  const capability = CAPABILITIES.find((c) => c.id === id);
  return Boolean(capability?.surfaces.webmcp) && !capability?.excluded?.webmcp;
}

/**
 * What the registrar may expose: exactly the candidates whose every
 * capability the registry maps onto WebMCP (ADR 0065). With
 * `transport.status.view` excluded as operator topology (ADR 0132), this is
 * empty — the registry decides, not this file.
 */
export const TRANSPORT_AGENT_TOOLS: readonly TransportAgentTool[] = [
  TRANSPORT_STATUS_VIEW_CANDIDATE,
].filter((tool) => tool.capabilityIds.every(webmcpMapped));

/** Throws when a transport tool name reaches for authority it must not have. */
export function assertsTransportToolsReferenceOnly(
  names: readonly string[],
): void {
  const offending = names.filter(
    (name) =>
      /transport/i.test(name) && TRANSPORT_FORBIDDEN_TOOL_PATTERN.test(name),
  );
  if (offending.length > 0) {
    throw new Error(`transport_tool_forbidden:${offending.join(",")}`);
  }
}
