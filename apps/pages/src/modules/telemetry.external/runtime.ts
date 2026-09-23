/**
 * `telemetry.external` — anonymous usage and error telemetry to an
 * operator-configured collector.
 *
 * This module registers nothing, and there is no Pages implementation
 * behind it: no collector client, no sampler, no queue, no error hook.
 * `lib/capabilities/ownership.ts` says the same thing ("`telemetry.external`
 * has no Pages code today at all — the module is the only thing that will
 * ever carry it"), and the classification map lists no source file for it.
 *
 * The id exists so an operator can *prohibit* it: a managed instance policy
 * that names `telemetry.external` as prohibited is meaningful only if the
 * id resolves, and a hardened distribution can then assert that nothing in
 * the build reaches a collector. Keeping the module empty is the strongest
 * form of that promise — a deployment that asks for no telemetry ships no
 * telemetry code.
 *
 * Any future collector belongs here and nowhere else: it must go through
 * `ctx.egress` with this capability's declared `external-service` class,
 * start from a `background-job` under the lease, and stop the moment the
 * lease aborts. Nothing may send before the capability is approved, and
 * nothing may queue while offline (the descriptor's offline limit).
 *
 * Egress: none. Side effects: none at import.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "telemetry.external";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    return createActivation(ctx, CAPABILITY).handle();
  },
};
