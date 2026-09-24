import { type AgentSurface, CAPABILITIES, type Surface } from "./index.js";

/** Every surface, in the order the gap ledger lists them. */
export const SURFACES: readonly Surface[] = [
  "cli",
  "pwa",
  "mcp_host",
  "mcp_client",
  "webmcp",
  "extension",
  "android",
];

function surfaceNames(surface: AgentSurface): readonly string[] {
  const names = new Set<string>();
  for (const capability of CAPABILITIES) {
    const name = capability.surfaces[surface];
    if (name) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** Every MCP host-server tool name the registry demands. */
export function mcpHostCatalog(): readonly string[] {
  return surfaceNames("mcp_host");
}

/** Every MCP client-server tool name the registry demands. */
export function mcpClientCatalog(): readonly string[] {
  return surfaceNames("mcp_client");
}

/** Every WebMCP tool name the registry demands. */
export function webmcpCatalog(): readonly string[] {
  return surfaceNames("webmcp");
}

/** WebMCP tool names the Pages PWA registers: the whole WebMCP catalog. */
export function webmcpPagesCatalog(): readonly string[] {
  return webmcpCatalog();
}

/** Capabilities deliberately withheld from a surface, for docs and audits. */
export function exclusionsFor(
  surface: AgentSurface,
): readonly { id: string; reason: string; adr: string }[] {
  return CAPABILITIES.filter((c) => c.excluded?.[surface]).map((c) => {
    const exclusion = c.excluded?.[surface];
    if (!exclusion) {
      throw new Error(`exclusion_missing:${c.id}`);
    }
    return { id: c.id, reason: exclusion.reason, adr: exclusion.adr };
  });
}

/**
 * Every surface of every capability that is neither mapped nor excluded:
 * the work between this product and the same product on that target.
 * `surface-gaps.json` records it; the registry test fails when the two
 * differ, so a gap is always a reviewed line in that ledger (ADR 0139).
 */
export function surfaceGaps(): Readonly<Record<Surface, readonly string[]>> {
  const gaps: Record<Surface, string[]> = {
    cli: [],
    pwa: [],
    mcp_host: [],
    mcp_client: [],
    webmcp: [],
    extension: [],
    android: [],
  };
  for (const capability of CAPABILITIES) {
    for (const surface of SURFACES) {
      const mapped = capability.surfaces[surface] ?? null;
      if (mapped === null && !capability.excluded?.[surface]) {
        gaps[surface].push(capability.id);
      }
    }
  }
  for (const surface of SURFACES) gaps[surface].sort();
  return gaps;
}
