/**
 * What the installation's resolved plan says about a carrier (ADR 0150 §7).
 *
 * One rule, read from the plan alone so it can be asked twice: by the shell
 * before a carrier opens (`apps/pages/.../carriers/allowed.ts`), and by the
 * session whenever the plan changes (`session.ts`), which closes a carrier a
 * new plan no longer allows. A WebSocket cannot go through the egress port
 * (it is http(s)-only), so for Nostr, MQTT and NATS this is the whole gate;
 * ntfy is the egress port's, asked at every request, and is not judged here.
 *
 * Allowed when the capability is approved, external services are allowed,
 * and — once the operator narrowed the policy — the carrier's own origin is on
 * the list. A socket's origin is its `wss://host`: an `https://` twin does not
 * stand in for it, because a CSP does not honour one for the other.
 */

import {
  type EffectivePlan,
  capabilityState,
} from "@opensesame/capability-composition";
import {
  localNetworkFetchSeams,
  targetAddressSpaceFor,
} from "../local-network-fetch.js";
import type { CarrierSpec } from "./transport.js";

const CAPABILITY = "sharing.live";

/** The reason a carrier is not allowed under `plan`, as egress names it; else null. */
export type Refusal = string | null;

export function planRefusal(
  spec: CarrierSpec,
  plan: EffectivePlan | null,
): Refusal {
  // BroadcastChannel never leaves the browser; ntfy goes through the egress
  // port, which decides every request and which the carrier obeys at each one.
  if (spec.kind === "broadcast" || spec.kind === "ntfy") return null;
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    return "invalid-url";
  }
  if (plan === null || capabilityState(plan, CAPABILITY)?.approved !== true)
    return "capability-not-approved";
  const space = targetAddressSpaceFor(url.href);
  if (
    url.protocol !== "wss:" &&
    !(url.protocol === "ws:" && space === "loopback")
  )
    return "unsupported-scheme";
  // This device or a LAN is local operator authority whichever way a page
  // asks for it, and the deployment profile decides, as egress does for http.
  if (space !== undefined && !localNetworkFetchSeams.eligible())
    return "local-authority-not-permitted";
  if (plan.network.externalServices !== "allow")
    return "external-services-denied";
  const list = plan.network.allowedServiceOrigins;
  if (list.length > 0 && !list.includes(url.origin))
    return "origin-not-allowed";
  return null;
}
