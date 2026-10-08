import { host } from "../../host.js";
import { maybePage } from "../../ports.js";
import { OBSERVATION_EGRESS_PURPOSE } from "../capabilities/catalog-core.js";
import { CAPABILITY_CATALOG } from "../capabilities/catalog.js";
import { createEgressPort } from "../capabilities/egress.js";
import { compositionStore } from "../capabilities/store.js";
import { mayPairLocalAuthority } from "../deployment-profile.js";
const CAPABILITY = "vault.local-unlock";
/** Synchronous current-plan decision, independent of synthetic presentation. */
export function assertObservationEgress(destination: string): void {
  const plan = compositionStore.getSnapshot().plan;
  if (!plan) throw new Error("Observation delivery requires a resolved plan.");
  const descriptor = CAPABILITY_CATALOG.capabilities.find(
    (d) => d.id === CAPABILITY,
  );
  if (!descriptor) throw new Error("Observation delivery is unavailable.");
  const decision = createEgressPort({
    capability: descriptor,
    plan: () => compositionStore.getSnapshot().plan,
    allowedOrigins: [],
    mayPairLocalAuthority: () =>
      (!maybePage() && host().observationRuntime === "human-node-cli") ||
      mayPairLocalAuthority(),
  }).decide(destination, { purpose: OBSERVATION_EGRESS_PURPOSE });
  if (!decision.ok)
    throw new Error("Observation delivery is denied by the current plan.");
}
