/**
 * Transport status as this page holds it, read through the one decoder.
 *
 * The wire shape is `@opensesame/os-domain`'s `TransportStatusView` — the
 * TS mirror of `opensesame_domain::transport` (CONTRACT §3): `snake_case`,
 * externally tagged enums. `decodeTransportStatusView` is the only parser;
 * this module lifts what it admits into `kind`-tagged unions the panel can
 * switch on, and nothing here coerces a value the decoder refused.
 */
import {
  type BoundaryValue,
  type Custody,
  type IdentitySourceKind,
  type IdentitySourceRef,
  type PeerEvidenceView,
  TRANSPORT_POLICIES,
  type TransportPolicy,
  type TrustProfileRef,
  type TransportCapabilities as WireCapabilities,
  type CapabilityOutcome as WireOutcome,
  type TransportStatusView as WireStatusView,
  browserTransportCapabilities,
  decodeTransportStatusView,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

export { TRANSPORT_POLICIES };
export type {
  Custody,
  IdentitySourceKind,
  IdentitySourceRef,
  PeerEvidenceView,
  TransportPolicy,
  TrustProfileRef,
  WireStatusView,
};

/** `^[a-z0-9][a-z0-9._-]{0,63}$` — the one spelling of a reference name. */
export const REF_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type CapabilityOutcome =
  | { kind: "supported" }
  | { kind: "unsupported"; reason: string }
  | { kind: "external_provisioning_required"; reason: string };

export type TransportCapabilities = {
  native_pem: CapabilityOutcome;
  managed_certificate: CapabilityOutcome;
  spiffe_workload_api: CapabilityOutcome;
  browser_managed_external: CapabilityOutcome;
  browser_vault_key_injection: CapabilityOutcome;
  client_presents_certificate: boolean;
  server_enforces_certificate: boolean;
};

export type CredentialStatus =
  | { kind: "unconfigured" }
  | {
      kind: "configured";
      custody: Custody;
      generation: number;
      not_after: string;
      source: IdentitySourceKind;
    }
  | { kind: "expired"; generation: number }
  | { kind: "revoked"; generation: number }
  | { kind: "external_provisioning_required" }
  | { kind: "unsupported_in_browser" };

export type RuntimeStatus =
  | { kind: "not_loaded" }
  | { kind: "loaded"; generation: number; loaded_at: string }
  | { kind: "reload_failed"; generation: number; code: string };

export type ObservedAuthentication = {
  at: string;
  observer: string;
  target: string;
  generation: number;
  /** Safe evidence DTO — read as a fact about a peer, never as authority. */
  peer: PeerEvidenceView;
};

export type EnforcementStatus =
  | { kind: "unverified" }
  | {
      kind: "verified";
      at: string;
      target: string;
      generation: number;
      accepted_with_certificate: boolean;
      rejected_without_certificate: boolean;
      fresh_until: string;
    }
  | {
      kind: "stale";
      verified_at: string;
      generation: number;
      current_generation: number;
    };

export type TransportStatusView = {
  target: string;
  desired: TransportPolicy;
  credential: CredentialStatus;
  runtime: RuntimeStatus;
  observed: ObservedAuthentication | null;
  enforcement: EnforcementStatus;
  capabilities: TransportCapabilities;
};

export function isTransportPolicy(
  value: BoundaryValue,
): value is TransportPolicy {
  return isString(value) && TRANSPORT_POLICIES.some((p) => p === value);
}

function liftOutcome(outcome: WireOutcome): CapabilityOutcome {
  if (outcome === "supported") return { kind: "supported" };
  if ("unsupported" in outcome) {
    return { kind: "unsupported", reason: outcome.unsupported.reason };
  }
  return {
    kind: "external_provisioning_required",
    reason: outcome.external_provisioning_required.reason,
  };
}

export function liftCapabilities(
  wire: WireCapabilities,
): TransportCapabilities {
  return {
    native_pem: liftOutcome(wire.native_pem),
    managed_certificate: liftOutcome(wire.managed_certificate),
    spiffe_workload_api: liftOutcome(wire.spiffe_workload_api),
    browser_managed_external: liftOutcome(wire.browser_managed_external),
    browser_vault_key_injection: liftOutcome(wire.browser_vault_key_injection),
    client_presents_certificate: wire.client_presents_certificate,
    server_enforces_certificate: wire.server_enforces_certificate,
  };
}

/** What a page can say about itself without probing anything. */
export function browserCapabilities(): TransportCapabilities {
  return liftCapabilities(browserTransportCapabilities());
}

function liftCredential(wire: WireStatusView["credential"]): CredentialStatus {
  if (isString(wire)) return { kind: wire };
  if ("configured" in wire) {
    const c = wire.configured;
    return {
      kind: "configured",
      custody: c.custody,
      generation: c.generation,
      not_after: c.not_after,
      source: c.kind,
    };
  }
  if ("expired" in wire) {
    return { kind: "expired", generation: wire.expired.generation };
  }
  return { kind: "revoked", generation: wire.revoked.generation };
}

function liftRuntime(wire: WireStatusView["runtime"]): RuntimeStatus {
  if (isString(wire)) return { kind: "not_loaded" };
  if ("loaded" in wire) return { kind: "loaded", ...wire.loaded };
  return { kind: "reload_failed", ...wire.reload_failed };
}

function liftEnforcement(
  wire: WireStatusView["enforcement"],
): EnforcementStatus {
  if (isString(wire)) return { kind: "unverified" };
  if ("verified" in wire) return { kind: "verified", ...wire.verified };
  return { kind: "stale", ...wire.stale };
}

/** Lift a decoded wire view into the page's tagged shape. */
export function liftTransportStatusView(
  wire: WireStatusView,
): TransportStatusView {
  return {
    target: wire.target,
    desired: wire.desired,
    credential: liftCredential(wire.credential),
    runtime: liftRuntime(wire.runtime),
    observed: wire.observed ? { ...wire.observed } : null,
    enforcement: liftEnforcement(wire.enforcement),
    capabilities: liftCapabilities(wire.capabilities),
  };
}

/** Read a `TransportStatusView`; anything the decoder refuses is null. */
export function parseTransportStatusView(
  value: BoundaryValue,
): TransportStatusView | null {
  if (!isJsonObject(value)) return null;
  const decoded = decodeTransportStatusView(value);
  return decoded.ok ? liftTransportStatusView(decoded.value) : null;
}
