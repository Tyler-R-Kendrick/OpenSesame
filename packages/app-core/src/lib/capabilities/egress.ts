import type {
  CapabilityDescriptor,
  CapabilityId,
  EffectivePlan,
  EgressClass,
} from "@opensesame/capability-composition";
/**
 * Destination-validated fetch for optional modules (S18).
 *
 * A module receives an `EgressPort` (runtime-contract.ts), never an unbounded
 * `fetch`. Every request is classified (`EgressClass`) — from the purpose the
 * module names, which must be one its descriptor declared — and checked
 * against three things the module cannot change: the capability's declared
 * egress, the CURRENT plan's network envelope, and the deployment profile.
 * Anything that fails is refused before a socket opens, so an `Authorization`
 * header can only ever travel to a destination that passed (NET-05); a
 * redirect is never followed anywhere (NET-04); and no URL with a query
 * string is ever written to an error or a log (`redactUrl`).
 */
import { pageOrigin } from "../../ports.js";
import {
  localNetworkFetchSeams,
  targetAddressSpaceFor,
} from "../local-network-fetch.js";
import { CAPABILITY_CATALOG } from "./catalog.js";
import { egressSeams } from "./egress-default.js";
import type { EgressPort as ContractEgressPort } from "./runtime-contract.js";
import { compositionStore } from "./store.js";

export type EgressDenialCode =
  | "capability-not-approved"
  | "capability-mismatch"
  | "invalid-url"
  | "unsupported-scheme"
  | "purpose-not-declared"
  | "class-not-declared"
  | "not-same-origin"
  | "external-services-denied"
  | "origin-not-allowed"
  | "local-authority-not-permitted"
  | "not-local-network"
  | "navigation-not-fetchable"
  | "redirect-refused";

export class EgressDenied extends Error {
  readonly code: EgressDenialCode;
  readonly capability: CapabilityId;
  /** Origin and path only; the query and fragment never reach a message. */
  readonly destination: string;

  constructor(
    code: EgressDenialCode,
    capability: CapabilityId,
    destination: string,
  ) {
    super(`egress refused (${code}) for ${capability} → ${destination}`);
    this.name = "EgressDenied";
    this.code = code;
    this.capability = capability;
    this.destination = destination;
  }
}

/** What a module says about a request; `purpose` must match a declaration. */
export type EgressRequestMeta = Readonly<{
  capability?: CapabilityId;
  purpose?: string;
  class?: EgressClass;
}>;

export type EgressDecision = Readonly<
  | { ok: true; class: EgressClass; crossOrigin: boolean; destination: string }
  | { ok: false; code: EgressDenialCode; destination: string }
>;

/**
 * The runtime contract's `EgressPort` (runtime-contract.ts owns the base type)
 * widened with what this adapter adds: the capability it is bound to and
 * `decide`, a dry run of the same check `fetch` makes. The intersection keeps
 * the dependency pointing one way — this module reads the contract, the
 * contract never reads this module's shape — so a module written against the
 * base port keeps compiling against the port it is actually handed.
 */
export type EgressPort = ContractEgressPort &
  Readonly<{
    capability: CapabilityId;
    decide(input: URL | string, meta?: EgressRequestMeta): EgressDecision;
    fetch(
      input: URL | string,
      init?: RequestInit,
      meta?: EgressRequestMeta,
    ): Promise<Response>;
  }>;

export type EgressPortOptions = Readonly<{
  capability: CapabilityDescriptor;
  /** Read on every request so a revoked plan refuses at once. */
  plan: () => EffectivePlan | null;
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

function parseDestination(
  input: string | URL,
  base: string | undefined,
): URL | null {
  try {
    return input instanceof URL ? input : new URL(input, base);
  } catch {
    return null;
  }
}

function approvedIn(plan: EffectivePlan | null, id: CapabilityId): boolean {
  return plan !== null && Object.hasOwn(plan.capabilities, id)
    ? plan.capabilities[id].approved
    : false;
}

/** The class a request belongs to: explicit, or the declared purpose's, or inferred. */
function classify(
  descriptor: CapabilityDescriptor,
  meta: EgressRequestMeta | undefined,
  crossOrigin: boolean,
): EgressClass | "purpose-not-declared" {
  if (meta?.class !== undefined) return meta.class;
  if (meta?.purpose !== undefined && meta.purpose !== "") {
    const declared = descriptor.egress.find((e) => e.purpose === meta.purpose);
    return declared === undefined ? "purpose-not-declared" : declared.class;
  }
  return crossOrigin ? "external-service" : "application-assets";
}

function decideExternal(
  url: URL,
  plan: EffectivePlan,
  destination: string,
): EgressDecision {
  if (
    url.protocol !== "https:" &&
    targetAddressSpaceFor(url.href) !== "loopback"
  )
    return { ok: false, code: "unsupported-scheme", destination };
  if (plan.network.externalServices !== "allow")
    return { ok: false, code: "external-services-denied", destination };
  const list = plan.network.allowedServiceOrigins;
  if (list.length > 0 && !list.includes(url.origin))
    return { ok: false, code: "origin-not-allowed", destination };
  return {
    ok: true,
    class: "external-service",
    crossOrigin: true,
    destination,
  };
}

function decideLocal(
  url: URL,
  options: EgressPortOptions,
  destination: string,
): EgressDecision {
  const permitted =
    options.mayPairLocalAuthority ?? localNetworkFetchSeams.eligible;
  if (!permitted())
    return { ok: false, code: "local-authority-not-permitted", destination };
  if (targetAddressSpaceFor(url.href) === undefined)
    return { ok: false, code: "not-local-network", destination };
  return {
    ok: true,
    class: "peer-or-local-network",
    crossOrigin: true,
    destination,
  };
}

/**
 * The checks that come before a class is even chosen: the caller named this
 * capability, the plan still approves it, and the destination is a URL this
 * port could fetch at all.
 */
type Admission = Readonly<{ code: EgressDenialCode } | { url: URL }>;

function admit(
  options: EgressPortOptions,
  url: URL | null,
  meta: EgressRequestMeta | undefined,
): Admission {
  const id = options.capability.id;
  if (meta?.capability !== undefined && meta.capability !== id)
    return { code: "capability-mismatch" };
  if (!approvedIn(options.plan(), id))
    return { code: "capability-not-approved" };
  if (url === null) return { code: "invalid-url" };
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { code: "unsupported-scheme" };
  return { url };
}

function decide(
  options: EgressPortOptions,
  input: string | URL,
  meta: EgressRequestMeta | undefined,
): EgressDecision {
  const parsed = parseDestination(input, options.allowedOrigins[0]);
  const destination = parsed === null ? redactUrl(input) : redactUrl(parsed);
  const admission = admit(options, parsed, meta);
  if ("code" in admission)
    return { ok: false, code: admission.code, destination };
  const url = admission.url;
  const crossOrigin = !options.allowedOrigins.includes(url.origin);
  const egressClass = classify(options.capability, meta, crossOrigin);
  if (egressClass === "purpose-not-declared")
    return { ok: false, code: "purpose-not-declared", destination };
  if (egressClass === "user-mediated-navigation")
    return { ok: false, code: "navigation-not-fetchable", destination };
  if (egressClass === "application-assets") {
    return crossOrigin
      ? { ok: false, code: "not-same-origin", destination }
      : { ok: true, class: egressClass, crossOrigin: false, destination };
  }
  if (!options.capability.egress.some((e) => e.class === egressClass))
    return { ok: false, code: "class-not-declared", destination };
  const plan = options.plan();
  if (plan === null)
    return { ok: false, code: "capability-not-approved", destination };
  return egressClass === "external-service"
    ? decideExternal(url, plan, destination)
    : decideLocal(url, options, destination);
}

/**
 * The request as it may leave: redirects are never followed (a redirect
 * response is an error, wherever it points), credentials are omitted
 * off-origin, and `Authorization` stays only because the destination passed.
 */
function prepareInit(
  init: RequestInit | undefined,
  crossOrigin: boolean,
): RequestInit {
  const prepared: RequestInit = {
    ...init,
    headers: new Headers(init?.headers),
    redirect: "manual",
  };
  if (crossOrigin) prepared.credentials = "omit";
  return prepared;
}

function isRedirect(response: Response): boolean {
  return (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  );
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
      const url = parseDestination(input, options.allowedOrigins[0]);
      const href =
        url === null
          ? decision.destination
          : `${url.origin}${url.pathname}${url.search}`;
      const response = await fetchImpl(
        href,
        prepareInit(init, decision.crossOrigin),
      );
      if (isRedirect(response)) {
        throw new EgressDenied(
          "redirect-refused",
          capability,
          decision.destination,
        );
      }
      return response;
    },
  };
}

/**
 * Replace the same-origin default (`egress-default.ts`) with the plan-aware
 * port. Called once by the core boot after `compositionStore.boot`; the port
 * re-reads the current plan on every request, so no boot ordering can leave
 * a module holding a wider port than its plan.
 */
export function installPlanAwareEgress(
  origin: string = pageOrigin(),
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
