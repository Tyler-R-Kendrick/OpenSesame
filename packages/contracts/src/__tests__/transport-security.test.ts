import { describe, expect, it } from "vitest";
import {
  PeerEvidenceViewSchema,
  PeerIdentitySelectorSchema,
  ServiceBindingSetSchema,
  TransportCapabilitiesSchema,
  TransportErrorViewSchema,
  TransportStatusViewSchema,
  TransportTimestampSchema,
} from "../transport-security.js";

const HEX_A = "a".repeat(64);

describe("transport-security zod schemas", () => {
  it("timestamps must carry an offset and canonicalize to UTC millis", () => {
    expect(TransportTimestampSchema.parse("2026-09-22T15:30:00+05:30")).toBe(
      "2026-09-22T10:00:00.000Z",
    );
    for (const bad of [
      "2026-09-22T10:00:00",
      "2026-02-30T00:00:00Z",
      "2026-09-22T10:00:00.123456Z",
      1758535200,
    ]) {
      expect(TransportTimestampSchema.safeParse(bad).success, String(bad)).toBe(
        false,
      );
    }
  });

  it("selectors are exact-match and single-keyed", () => {
    expect(
      PeerIdentitySelectorSchema.safeParse({ dns_name: "a.example" }).success,
    ).toBe(true);
    for (const bad of [
      { dns_name: "*.example" },
      { common_name: "x" },
      { dns_name: "a.example", uri_san: "urn:x" },
      "a.example",
    ]) {
      expect(PeerIdentitySelectorSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("browser_vault_key_injection can only be unsupported", () => {
    const base = {
      native_pem: "supported",
      managed_certificate: "supported",
      spiffe_workload_api: { unsupported: { reason: "no socket" } },
      browser_managed_external: { unsupported: { reason: "native" } },
      browser_vault_key_injection: { unsupported: { reason: "browser" } },
      client_presents_certificate: true,
      server_enforces_certificate: false,
    };
    expect(TransportCapabilitiesSchema.safeParse(base).success).toBe(true);
    expect(
      TransportCapabilitiesSchema.safeParse({
        ...base,
        browser_vault_key_injection: "supported",
      }).success,
    ).toBe(false);
    expect(
      TransportCapabilitiesSchema.safeParse({
        ...base,
        server_enforces_certificate: "false",
      }).success,
    ).toBe(false);
    expect(
      TransportCapabilitiesSchema.safeParse({ ...base, hardware: true })
        .success,
    ).toBe(false);
  });

  it("a binding set is strict, revisioned, and duplicate-free", () => {
    const binding = {
      id: "bridge",
      revision: 1,
      enabled: true,
      revoked: false,
      scope: "deployment",
      trust_profile: { name: "private-root" },
      peer: { spiffe_id: "spiffe://example.org/ns/prod/sa/nats-bridge" },
      service_principal: "svc:bridge",
      purpose: "nats_auth_bridge",
      allowed_operations: ["nats.callout.decide"],
      allowed_audiences: [],
      denied_thumbprints: [],
    };
    const parsed = ServiceBindingSetSchema.parse({
      revision: 1,
      bindings: [binding],
    });
    expect(parsed.bindings[0]?.not_after).toBeNull();
    expect(
      ServiceBindingSetSchema.safeParse({ revision: 0, bindings: [] }).success,
    ).toBe(false);
    expect(
      ServiceBindingSetSchema.safeParse({
        revision: 1,
        bindings: [binding, binding],
      }).success,
    ).toBe(false);
    expect(
      ServiceBindingSetSchema.safeParse({
        revision: 1,
        bindings: [{ ...binding, role: "admin" }],
      }).success,
    ).toBe(false);
    expect(
      ServiceBindingSetSchema.safeParse({
        revision: 1,
        bindings: [{ ...binding, allowed_operations: [] }],
      }).success,
    ).toBe(false);
  });

  it("views refuse a verified flag and cross-target probes", () => {
    const view = {
      source: "direct_tls",
      identities: [{ leaf_thumbprint_sha256: HEX_A }],
      leaf_thumbprint_sha256: HEX_A,
      not_before: "2026-09-22T00:00:00Z",
      not_after: "2026-09-23T00:00:00Z",
      trust_profile: { name: "private-root" },
      trust_generation: 3,
      credential_generation: 7,
      listener: "host-tls",
      policy: "mtls_required",
      tls_version: "tls13",
      authenticated_at: "2026-09-22T09:59:00Z",
      usable_until: "2026-09-22T10:29:00Z",
    };
    const parsed = PeerEvidenceViewSchema.parse(view);
    expect(parsed.ingress).toBeNull();
    expect(parsed.not_before).toBe("2026-09-22T00:00:00.000Z");
    expect(
      PeerEvidenceViewSchema.safeParse({ ...view, verified: true }).success,
    ).toBe(false);
    const status = {
      target: "host-tls",
      desired: "mtls_required",
      credential: "unconfigured",
      runtime: "not_loaded",
      enforcement: {
        verified: {
          at: "2026-09-22T09:00:00Z",
          target: "worker-tls",
          generation: 3,
          accepted_with_certificate: true,
          rejected_without_certificate: true,
          fresh_until: "2026-09-22T11:00:00Z",
        },
      },
      capabilities: {
        native_pem: "supported",
        managed_certificate: "supported",
        spiffe_workload_api: "supported",
        browser_managed_external: { unsupported: { reason: "native" } },
        browser_vault_key_injection: { unsupported: { reason: "browser" } },
        client_presents_certificate: true,
        server_enforces_certificate: true,
      },
    };
    expect(TransportStatusViewSchema.safeParse(status).success).toBe(false);
    expect(
      TransportStatusViewSchema.safeParse({
        ...status,
        enforcement: {
          ...status.enforcement,
          verified: { ...status.enforcement.verified, target: "host-tls" },
        },
      }).success,
    ).toBe(true);
    expect(TransportErrorViewSchema.parse({ code: "peer_not_bound" })).toEqual({
      code: "peer_not_bound",
      detail: null,
    });
    expect(
      TransportErrorViewSchema.safeParse({ code: "network_error" }).success,
    ).toBe(false);
  });
});
