/**
 * The capability build artifacts this shell compiles in (ADR 0130): the
 * optional-module table and the distribution contract, both virtual modules
 * of `scripts/capability-compose-plugin.mjs`. The core reads them through the
 * host (ADR 0133), imported lazily so boot never evaluates an optional module.
 */
import type { CapabilityArtifacts } from "@opensesame/app-core/host.js";

export const capabilityArtifacts: CapabilityArtifacts = {
  moduleTable: () =>
    import("../lib/capabilities/module-table.js").then((m) => m.MODULE_TABLE),
  distribution: () =>
    import("../lib/capabilities/distribution.js").then((m) => m.DISTRIBUTION),
};
