/**
 * Whether this installation lets a carrier be opened at all (ADR 0150 §7),
 * asked before any socket or request leaves.
 *
 * The module's `EgressPort` is the gate for anything over http(s): ntfy asks
 * it to decide, and then fetches through it. A WebSocket is not fetchable —
 * the port is http(s)-only — so the three socket kinds (Nostr, MQTT, NATS)
 * are held to the same rule here, against the same current plan: the
 * capability approved, external services allowed, and — when the operator
 * narrowed the policy — the carrier's own `wss://host` origin on the list.
 * That entry is the one a CSP needs too: an `https:` source never admits a
 * WebSocket, so an `https://` twin does not stand in for it.
 */

import { LIVE_CARRIER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-optional-vault.js";
import type { EgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import {
  type Refusal,
  planRefusal,
} from "@opensesame/app-core/lib/live/carrier-policy.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";
import type { EffectivePlan } from "@opensesame/capability-composition";

export const CAPABILITY = "sharing.live";

/**
 * The declared purpose of this capability's external-service egress, read
 * from the catalog's own declaration (`catalog-optional-vault.ts`): egress
 * classifies a request by it, exactly.
 */
export const CARRIER_PURPOSE = LIVE_CARRIER_PURPOSE;

/** What egress is told about every carrier request. */
export const CARRIER_META = {
  capability: CAPABILITY,
  purpose: CARRIER_PURPOSE,
} as const;

export type { Refusal };

export type CarrierGate = Readonly<{
  egress: EgressPort;
  /** The current plan, read on every ask so a withdrawal refuses at once. */
  plan: () => EffectivePlan | null;
}>;

/**
 * Why `spec` may not be opened, or null when it may. BroadcastChannel never
 * leaves the browser and is always allowed; a session it belongs to ends the
 * moment the capability is withdrawn (`lib/live/session.ts`).
 */
export function carrierRefusal(spec: CarrierSpec, gate: CarrierGate): Refusal {
  if (spec.kind === "broadcast") return null;
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    return "invalid-url";
  }
  if (spec.kind === "ntfy") {
    const decision = gate.egress.decide(url, CARRIER_META);
    return decision.ok ? null : decision.code;
  }
  return planRefusal(spec, gate.plan());
}

/** Whether `spec` may be opened under the current plan. */
export function carrierAllowed(spec: CarrierSpec, gate: CarrierGate): boolean {
  return carrierRefusal(spec, gate) === null;
}
