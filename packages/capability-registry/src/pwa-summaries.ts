import type { Capability } from "./types.js";

/**
 * What a page needs to know about a capability it can reach: its id, its
 * title and its plane. The in-product support context reads only these, so
 * Pages ships this projection rather than the
 * whole registry (`pwa-summaries.json`, written by `generate`) — every surface map and exclusion reason of every CLI,
 * daemon and MCP operation stays out of the browser bundle (ADR 0130,
 * ADR 0150 §7: an optional plugin's registry rows must not weigh on a
 * default install).
 */
export type PwaCapabilitySummary = Pick<
  Capability,
  "id" | "title" | "plane"
> & {
  surfaces: { pwa: string };
};

/** The projection, in registry order. `pwa-summaries.json` must equal this. */
export function pwaSummaries(
  capabilities: readonly Capability[],
): PwaCapabilitySummary[] {
  return capabilities.flatMap((capability) =>
    capability.surfaces.pwa === null
      ? []
      : [
          {
            id: capability.id,
            title: capability.title,
            plane: capability.plane,
            surfaces: { pwa: capability.surfaces.pwa },
          },
        ],
  );
}
