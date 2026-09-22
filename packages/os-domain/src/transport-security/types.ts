/**
 * Transport-security wire contract (ADR 0130) — the TypeScript mirror of
 * `opensesame_domain::transport`. Every name here is a wire spelling shared
 * with the Rust plane: snake_case fields, externally tagged enums, strict
 * RFC 3339 timestamps in canonical UTC-millisecond form. Nothing in this
 * module is trusted evidence; a decoded view proves only that a document was
 * well-formed.
 */

export const TRANSPORT_POLICIES = [
  "existing_local",
  "server_tls",
  "mtls_required",
  "trusted_ingress",
] as const;
export type TransportPolicy = (typeof TRANSPORT_POLICIES)[number];

export const TLS_VERSIONS = ["tls12", "tls13"] as const;
export type TlsVersion = (typeof TLS_VERSIONS)[number];

export const IDENTITY_SOURCE_KINDS = [
  "pem_files",
  "managed_certificate",
  "spiffe_workload_api",
  "browser_managed",
] as const;
export type IdentitySourceKind = (typeof IDENTITY_SOURCE_KINDS)[number];

export const CUSTODIES = [
  "native_file_exportable",
  "host_sealed_exportable_to_host",
  "workload_api_delivered",
  "browser_external",
] as const;
export type Custody = (typeof CUSTODIES)[number];

export const TRUST_PROFILE_KINDS = [
  "web_pki_dns",
  "private_root",
  "spiffe_trust_domain",
] as const;
export type TrustProfileKind = (typeof TRUST_PROFILE_KINDS)[number];

export const EVIDENCE_SOURCES = [
  "direct_tls",
  "local_ipc",
  "trusted_ingress_assertion",
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const BINDING_PURPOSES = [
  "nats_auth_bridge",
  "worker_client",
  "identity_mapping_client",
  "trusted_ingress",
  "upstream_connector",
  "service_probe",
] as const;
export type BindingPurpose = (typeof BINDING_PURPOSES)[number];

export const TRANSPORT_ERROR_CODES = [
  "identity_missing",
  "key_pair_mismatch",
  "trust_unknown",
  "peer_not_bound",
  "peer_disallowed",
  "ambiguous_binding",
  "evidence_expired",
  "evidence_revoked",
  "generation_stale",
  "source_unsupported",
  "forwarded_evidence_unverified",
  "proof_mismatch",
  "listener_policy_mismatch",
  "binding_disabled",
  "enforcement_unsupported",
  "policy_downgrade_refused",
  "malformed_configuration",
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

/** Operation strings a binding may allow (exact spellings). */
export const TRANSPORT_OPERATIONS = {
  natsCalloutDecide: "nats.callout.decide",
  workerProvidersList: "worker.providers.list",
  workerHealthReady: "worker.health.ready",
  principalsMappingResolve: "principals.mapping.resolve",
  ingressForward: "ingress.forward",
  transportProbe: "transport.probe",
  connectorInvoke: "connector.invoke",
} as const;

export interface TransportErrorView {
  readonly code: TransportErrorCode;
  readonly detail: string | null;
}

/** Outcome of decoding or resolving: a value, or a stable error code. */
export type TransportResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TransportErrorView };

/** Public reference to an operator-registered identity or trust bundle. */
export interface IdentitySourceRef {
  readonly name: string;
}
export interface TrustProfileRef {
  readonly name: string;
}

/** Exact-match only. No wildcards, no CN, no email, no IP. */
export type PeerIdentitySelector =
  | { readonly spiffe_id: string }
  | { readonly dns_name: string }
  | { readonly uri_san: string }
  | { readonly leaf_thumbprint_sha256: string };

export const SELECTOR_KINDS = [
  "spiffe_id",
  "dns_name",
  "uri_san",
  "leaf_thumbprint_sha256",
] as const;
export type SelectorKind = (typeof SELECTOR_KINDS)[number];

export type BindingScope =
  | "deployment"
  | { readonly organization: { readonly organization_id: string } };

/** A canonical RFC 3339 instant: UTC, millisecond precision, `Z` suffix. */
export type Rfc3339Utc = string;

export interface ServiceBinding {
  readonly id: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly revoked: boolean;
  readonly scope: BindingScope;
  readonly trust_profile: TrustProfileRef;
  readonly peer: PeerIdentitySelector;
  readonly service_principal: string;
  readonly purpose: BindingPurpose;
  readonly allowed_operations: readonly string[];
  readonly allowed_audiences: readonly string[];
  readonly not_after: Rfc3339Utc | null;
  readonly denied_thumbprints: readonly string[];
}

export interface ServiceBindingSet {
  readonly revision: number;
  readonly bindings: readonly ServiceBinding[];
}

export type CapabilityOutcome =
  | "supported"
  | { readonly unsupported: { readonly reason: string } }
  | { readonly external_provisioning_required: { readonly reason: string } };

export interface TransportCapabilities {
  readonly native_pem: CapabilityOutcome;
  readonly managed_certificate: CapabilityOutcome;
  readonly spiffe_workload_api: CapabilityOutcome;
  readonly browser_managed_external: CapabilityOutcome;
  /** Always `{ unsupported }`. */
  readonly browser_vault_key_injection: CapabilityOutcome;
  readonly client_presents_certificate: boolean;
  readonly server_enforces_certificate: boolean;
}

export interface PeerEvidenceView {
  readonly source: EvidenceSource;
  readonly identities: readonly PeerIdentitySelector[];
  readonly leaf_thumbprint_sha256: string;
  readonly not_before: Rfc3339Utc;
  readonly not_after: Rfc3339Utc;
  readonly trust_profile: TrustProfileRef;
  readonly trust_generation: number;
  readonly credential_generation: number;
  readonly listener: string;
  readonly policy: TransportPolicy;
  readonly tls_version: TlsVersion;
  readonly authenticated_at: Rfc3339Utc;
  readonly usable_until: Rfc3339Utc;
  readonly ingress: PeerEvidenceView | null;
}

export type CredentialStatus =
  | "unconfigured"
  | {
      readonly configured: {
        readonly custody: Custody;
        readonly generation: number;
        readonly not_after: Rfc3339Utc;
        readonly kind: IdentitySourceKind;
      };
    }
  | { readonly expired: { readonly generation: number } }
  | { readonly revoked: { readonly generation: number } }
  | "external_provisioning_required"
  | "unsupported_in_browser";

export type RuntimeStatus =
  | "not_loaded"
  | {
      readonly loaded: {
        readonly generation: number;
        readonly loaded_at: Rfc3339Utc;
      };
    }
  | {
      readonly reload_failed: {
        readonly generation: number;
        readonly code: TransportErrorCode;
      };
    };

export interface ObservedAuthentication {
  readonly at: Rfc3339Utc;
  readonly observer: string;
  readonly target: string;
  readonly generation: number;
  readonly peer: PeerEvidenceView;
}

export type EnforcementStatus =
  | "unverified"
  | {
      readonly verified: {
        readonly at: Rfc3339Utc;
        readonly target: string;
        readonly generation: number;
        readonly accepted_with_certificate: boolean;
        readonly rejected_without_certificate: boolean;
        readonly fresh_until: Rfc3339Utc;
      };
    }
  | {
      readonly stale: {
        readonly verified_at: Rfc3339Utc;
        readonly generation: number;
        readonly current_generation: number;
      };
    };

export interface TransportStatusView {
  readonly target: string;
  readonly desired: TransportPolicy;
  readonly credential: CredentialStatus;
  readonly runtime: RuntimeStatus;
  readonly observed: ObservedAuthentication | null;
  readonly enforcement: EnforcementStatus;
  readonly capabilities: TransportCapabilities;
}
