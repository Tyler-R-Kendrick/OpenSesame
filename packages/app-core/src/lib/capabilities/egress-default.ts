/**
 * The egress port a module is handed. With a resolved plan and the
 * capability's descriptor in hand it is S18's plan-aware adapter
 * (`createEgressPort`); before boot, or for a capability the catalog does
 * not know, it is the narrowest port there is — same-origin only, every
 * other destination refused before any request.
 */

import type { CapabilityId } from "@opensesame/capability-composition";
import { pageOrigin as hostOrigin, maybePage } from "../../ports.js";
import { CAPABILITY_CATALOG } from "./catalog.js";
import {
  EgressDenied,
  type EgressPort,
  type EgressPortOptions,
  type EgressRequestMeta,
  createEgressPort,
  redactUrl,
} from "./egress.js";
import { compositionStore } from "./store.js";

function pageOrigin(): string | null {
  try {
    return maybePage()?.location.origin ?? null;
  } catch {
    return null;
  }
}

/** Resolve `input` against the page and answer its origin, or null. */
export function destinationOrigin(input: URL | string): string | null {
  try {
    return new URL(String(input), pageOrigin() ?? undefined).origin;
  } catch {
    return null;
  }
}

/** Same-origin fetch only; every other destination is refused before any request. */
export function createSameOriginEgress(capability: CapabilityId): EgressPort {
  const decide = (input: URL | string) => {
    const origin = destinationOrigin(input);
    const own = pageOrigin();
    const destination = redactUrl(input);
    if (!origin)
      return { ok: false as const, code: "invalid-url" as const, destination };
    if (!own || origin !== own) {
      return {
        ok: false as const,
        code: "not-same-origin" as const,
        destination,
      };
    }
    return {
      ok: true as const,
      class: "application-assets" as const,
      crossOrigin: false,
      destination,
    };
  };
  return {
    capability,
    decide,
    async fetch(
      input: URL | string,
      init?: RequestInit,
      _meta?: EgressRequestMeta,
    ) {
      const decision = decide(input);
      if (!decision.ok) {
        throw new EgressDenied(decision.code, capability, decision.destination);
      }
      return fetch(input, { ...init, credentials: "omit", redirect: "error" });
    },
  };
}

/** The plan-aware port when the store can vouch for the capability; else same-origin. */
export function createPlanEgress(capability: CapabilityId): EgressPort {
  const plan = compositionStore.getSnapshot().plan;
  const descriptor = compositionStore
    .catalog()
    ?.capabilities.find((d) => d.id === capability);
  const origin = pageOrigin();
  if (!plan || !descriptor || !origin)
    return createSameOriginEgress(capability);
  return createEgressPort({
    capability: descriptor,
    plan: () => compositionStore.getSnapshot().plan,
    allowedOrigins: [origin],
  });
}

export const egressSeams = {
  createEgressPort: createPlanEgress as (
    capability: CapabilityId,
  ) => EgressPort,
};

/**
 * Replace the same-origin default with the plan-aware
 * port. Called once by the core boot after `compositionStore.boot`; the port
 * re-reads the current plan on every request, so no boot ordering can leave
 * a module holding a wider port than its plan.
 */
export function installPlanAwareEgress(
  origin: string = hostOrigin(),
  fetchImpl?: typeof fetch,
): void {
  egressSeams.createEgressPort = (capability: CapabilityId) => {
    const descriptor = CAPABILITY_CATALOG.capabilities.find(
      (d) => d.id === capability,
    );
    if (descriptor === undefined) {
      throw new EgressDenied("capability-not-approved", capability, origin);
    }
    const options: EgressPortOptions = {
      capability: descriptor,
      plan: () => compositionStore.getSnapshot().plan,
      allowedOrigins: [origin],
    };
    return createEgressPort(
      fetchImpl === undefined ? options : { ...options, fetchImpl },
    );
  };
}
