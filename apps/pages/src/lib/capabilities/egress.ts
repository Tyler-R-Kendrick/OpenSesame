/**
 * Destination-validated fetch for optional modules (S18).
 *
 * A module receives an `EgressPort`, never an unbounded `fetch`. Every request
 * is classified (ownership §4.3, `EgressClass`) and checked against three
 * things it cannot change: the capability's declared egress, the plan's
 * network envelope, and the deployment profile. Anything that fails is
 * refused before a socket opens — so an `Authorization` header can only ever
 * travel to a destination that passed (NET-05), a redirect is never
 * followed off-origin (NET-04), and no URL with a query string is ever
 * written to an error or a log (`redactUrl`).
 */
import type {
  CapabilityDescriptor,
  CapabilityId,
  EffectivePlan,
  EgressClass,
} from "@opensesame/capability-composition";
import {
  localNetworkFetchSeams,
  targetAddressSpaceFor,
} from "../local-network-fetch.js";

export type EgressDenialCode =
  | "capability-not-approved"
  | "invalid-url"
  | "unsupported-scheme"
  | "class-not-declared"
  | "not-same-origin"
  | "external-services-denied"
  | "origin-not-allowed"
  | "local-authority-not-permitted"
  | "not-local-network"
  | "navigation-not-fetchable"
  | "cross-origin-redirect";

export class EgressDenied extends Error {
  readonly code: EgressDenialCode;
  readonly capability: CapabilityId;
  /** Origin and path only; the query and fragment never reach a message. */
  readonly destination: string;

  constructor(code: EgressDenialCode, capability: CapabilityId, destination: string) {
    super(`egress refused (${code}) for ${capability} → ${destination}`);
    this.name = "EgressDenied";
    this.code = code;
    this.capability = capability;
    this.destination = destination;
  }
}

export type EgressRequestMeta = Readonly<{ class: EgressClass }>;

export type EgressDecision = Readonly<
  | { ok: true; class: EgressClass; crossOrigin: boolean; destination: string }
  | { ok: false; code: EgressDenialCode; destination: string }
>;

export type EgressPort = Readonly<{
  capability: CapabilityId;
  decide(input: string | URL, meta?: EgressRequestMeta): EgressDecision;
  fetch(input: string | URL, init?: RequestInit, meta?: EgressRequestMeta): Promise<Response>;
}>;

export type EgressPortOptions = Readonly<{
  capability: CapabilityDescriptor;
  plan: EffectivePlan;
  /** Origins that count as the application itself (the document origin). */
  allowedOrigins: readonly string[];
  /** Deployment-profile fact; defaults to `mayPairLocalAuthority`. */
  mayPairLocalAuthority?: () => boolean;
  fetchImpl?: typeof fetch;
}>;

/** Origin + pathname. Never the query, never the fragment, never credentials. */
export function redactUrl(input: string | URL): string {
  try {
    const url = input instanceof URL ? input : new URL(input);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function parseDestination(input: string | URL, base: string | undefined): URL | null {
  try {
    return input instanceof URL ? input : new URL(input, base);
  } catch {
    return null;
  }
}

function isLoopbackHost(url: URL): boolean {
  return targetAddressSpaceFor(url.href) === "loopback";
}

function inferClass(crossOrigin: boolean): EgressClass {
  return crossOrigin ? "external-service" : "application-assets";
}

function decideExternal(
  url: URL,
  options: EgressPortOptions,
  destination: string,
): EgressDecision {
  if (url.protocol !== "https:" && !isLoopbackHost(url))
    return { ok: false, code: "unsupported-scheme", destination };
  if (options.plan.network.externalServices !== "allow")
    return { ok: false, code: "external-services-denied", destination };
  const list = options.plan.network.allowedServiceOrigins;
  if (list.length > 0 && !list.includes(url.origin))
    return { ok: false, code: "origin-not-allowed", destination };
  return { ok: true, class: "external-service", crossOrigin: true, destination };
}

function decideLocal(
  url: URL,
  options: EgressPortOptions,
  destination: string,
): EgressDecision {
  const permitted = options.mayPairLocalAuthority ?? localNetworkFetchSeams.eligible;
  if (!permitted()) return { ok: false, code: "local-authority-not-permitted", destination };
  if (targetAddressSpaceFor(url.href) === undefined)
    return { ok: false, code: "not-local-network", destination };
  return { ok: true, class: "peer-or-local-network", crossOrigin: true, destination };
}

function decide(
  options: EgressPortOptions,
  input: string | URL,
  meta: EgressRequestMeta | undefined,
): EgressDecision {
  const self = options.allowedOrigins[0];
  const url = parseDestination(input, self);
  const destination = url === null ? redactUrl(input) : redactUrl(url);
  const approved = Object.hasOwn(options.plan.capabilities, options.capability.id)
    ? options.plan.capabilities[options.capability.id].approved
    : false;
  if (!approved) return { ok: false, code: "capability-not-approved", destination };
  if (url === null) return { ok: false, code: "invalid-url", destination };
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, code: "unsupported-scheme", destination };
  const crossOrigin = !options.allowedOrigins.includes(url.origin);
  const egressClass = meta?.class ?? inferClass(crossOrigin);
  if (egressClass === "user-mediated-navigation")
    return { ok: false, code: "navigation-not-fetchable", destination };
  if (egressClass === "application-assets") {
    return crossOrigin
      ? { ok: false, code: "not-same-origin", destination }
      : { ok: true, class: egressClass, crossOrigin: false, destination };
  }
  if (!options.capability.egress.some((e) => e.class === egressClass))
    return { ok: false, code: "class-not-declared", destination };
  return egressClass === "external-service"
    ? decideExternal(url, options, destination)
    : decideLocal(url, options, destination);
}

/**
 * The request as it may leave: manual redirects always (an opaque redirect is
 * an error, never followed), credentials omitted off-origin, and `Authorization`
 * kept only because the destination has already passed.
 */
function prepareInit(init: RequestInit | undefined, crossOrigin: boolean): RequestInit {
  const headers = new Headers(init?.headers);
  const prepared: RequestInit = { ...init, headers, redirect: "manual" };
  if (crossOrigin) prepared.credentials = "omit";
  return prepared;
}

/** Strip bearer material from an init that is about to be refused. */
export function stripAuthorization(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  return { ...init, headers, credentials: "omit" };
}

export function createEgressPort(options: EgressPortOptions): EgressPort {
  const fetchImpl = options.fetchImpl ?? fetch;
  const capability = options.capability.id;
  return {
    capability,
    decide: (input, meta) => decide(options, input, meta),
    async fetch(input, init, meta) {
      const decision = decide(options, input, meta);
      if (!decision.ok) {
        // Refused before any socket opens: the init, its Authorization header
        // included, never leaves this function (NET-05).
        throw new EgressDenied(decision.code, capability, decision.destination);
      }
      const response = await fetchImpl(
        decision.destination + queryOf(input, options.allowedOrigins[0]),
        prepareInit(init, decision.crossOrigin),
      );
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new EgressDenied("cross-origin-redirect", capability, decision.destination);
      }
      return response;
    },
  };
}

function queryOf(input: string | URL, base: string | undefined): string {
  const url = parseDestination(input, base);
  return url === null ? "" : `${url.search}${url.hash}`;
}
