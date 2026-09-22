/**
 * The egress port a module receives until S18's `egress.ts` is wired in:
 * same-origin only. A module that declared `external-service` egress is
 * still refused here — the default is the narrowest port, and widening it is
 * the network adapter's job, driven by the plan's `network` envelope.
 */

import type { CapabilityId } from "@opensesame/capability-composition";
import type { EgressPort } from "./runtime-contract.js";

export class EgressRefused extends Error {
  readonly capability: CapabilityId;
  constructor(capability: CapabilityId, reason: string) {
    super(`egress refused for ${capability}: ${reason}`);
    this.name = "EgressRefused";
    this.capability = capability;
  }
}

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
    const base = pageOrigin() ?? undefined;
    return new URL(String(input), base).origin;
  } catch {
    return null;
  }
}

/** Same-origin fetch only; every other destination is refused before any request. */
export function createSameOriginEgress(capability: CapabilityId): EgressPort {
  return {
    async fetch(input, init, meta) {
      const origin = destinationOrigin(input);
      const own = pageOrigin();
      if (!origin || !own || origin !== own) {
        throw new EgressRefused(
          meta.capability || capability,
          "destination is not this origin",
        );
      }
      return fetch(input, { ...init, credentials: "omit", redirect: "error" });
    },
  };
}

export const egressSeams = {
  /** S18 replaces this with the plan-aware adapter (`createEgressPort`). */
  createEgressPort: createSameOriginEgress as (
    capability: CapabilityId,
  ) => EgressPort,
};
