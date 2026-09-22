/**
 * The egress port a module is handed. With a resolved plan and the
 * capability's descriptor in hand it is S18's plan-aware adapter
 * (`createEgressPort`); before boot, or for a capability the catalog does
 * not know, it is the narrowest port there is — same-origin only, every
 * other destination refused before any request.
 */

import type { CapabilityId } from "@opensesame/capability-composition";
import {
  EgressDenied,
  type EgressPort,
  type EgressRequestMeta,
  createEgressPort,
  redactUrl,
} from "./egress.js";
import { compositionStore } from "./store.js";

function pageOrigin(): string | null {
  try {
    return globalThis.location?.origin ?? null;
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
