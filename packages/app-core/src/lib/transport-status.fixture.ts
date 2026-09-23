/**
 * A `TransportStatusView` exactly as the operator route serialises it
 * (CONTRACT §3: snake_case, externally tagged enums, strict RFC 3339). Test
 * data only; every timestamp is fixed so a test's clock decides staleness.
 */
import type { JsonObject } from "@opensesame/os-domain";

export const FIXTURE_NOW = Date.parse("2026-09-22T12:00:00Z");

export const FIXTURE_THUMBPRINT = "ab".repeat(32);

/** A safe peer-evidence DTO for the observation: a fact, never authority. */
export function peerEvidenceWire(): JsonObject {
  return {
    source: "direct_tls",
    identities: [
      { spiffe_id: "spiffe://example.org/probe" },
      { leaf_thumbprint_sha256: FIXTURE_THUMBPRINT },
    ],
    leaf_thumbprint_sha256: FIXTURE_THUMBPRINT,
    not_before: "2026-09-01T00:00:00Z",
    not_after: "2026-12-01T00:00:00Z",
    trust_profile: { name: "private-root" },
    trust_generation: 3,
    credential_generation: 3,
    listener: "host-tls",
    policy: "mtls_required",
    tls_version: "tls13",
    authenticated_at: "2026-09-22T11:00:00Z",
    usable_until: "2026-09-22T11:10:00Z",
    ingress: null,
  };
}

export function transportStatusWire(
  overrides: Partial<Record<string, JsonObject | string | null>> = {},
): JsonObject {
  return {
    target: "host-tls",
    desired: "mtls_required",
    credential: {
      configured: {
        custody: "host_sealed_exportable_to_host",
        generation: 3,
        not_after: "2026-12-01T00:00:00Z",
        kind: "managed_certificate",
      },
    },
    runtime: { loaded: { generation: 3, loaded_at: "2026-09-22T10:00:00Z" } },
    observed: {
      at: "2026-09-22T11:00:00Z",
      observer: "transport.probe",
      target: "host-tls",
      generation: 3,
      peer: peerEvidenceWire(),
    },
    enforcement: {
      verified: {
        at: "2026-09-22T11:00:00Z",
        target: "host-tls",
        generation: 3,
        accepted_with_certificate: true,
        rejected_without_certificate: true,
        fresh_until: "2026-09-22T13:00:00Z",
      },
    },
    capabilities: {
      native_pem: "supported",
      managed_certificate: "supported",
      spiffe_workload_api: { unsupported: { reason: "no socket" } },
      browser_managed_external: {
        external_provisioning_required: { reason: "browser" },
      },
      browser_vault_key_injection: { unsupported: { reason: "never" } },
      client_presents_certificate: true,
      server_enforces_certificate: true,
    },
    ...overrides,
  };
}
