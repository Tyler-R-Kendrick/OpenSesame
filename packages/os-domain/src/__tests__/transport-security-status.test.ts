import { describe, expect, it } from "vitest";
import type { JsonValue } from "../json.js";
import {
  TRANSPORT_ERROR_CODES,
  browserTransportCapabilities,
  decodeCapabilityOutcome,
  decodePeerEvidenceView,
  decodeTransportCapabilities,
  decodeTransportStatusView,
  enforcementProven,
  reconcileEnforcement,
} from "../transport-security/index.js";

const HEX_A = "a".repeat(64);
const NOW = new Date("2026-09-22T10:00:00.000Z");
const BRIDGE = { spiffe_id: "spiffe://example.org/ns/prod/sa/nats-bridge" };
const PROFILE = { name: "private-root" };

/** Domain values are readonly; the decoders read plain JSON. */
function asJson<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value));
}

describe("capabilities and status", () => {
  it("browser vault key injection is unsupported by construction and on decode", () => {
    const browser = browserTransportCapabilities();
    expect(browser.browser_vault_key_injection).toHaveProperty("unsupported");
    expect(browser.client_presents_certificate).toBe(false);
    expect(browser.server_enforces_certificate).toBe(false);
    expect(decodeTransportCapabilities("c", asJson(browser))).toEqual({
      ok: true,
      value: browser,
    });
    const forged = { ...browser, browser_vault_key_injection: "supported" };
    expect(decodeTransportCapabilities("c", asJson(forged)).ok).toBe(false);
    const external = {
      ...browser,
      browser_vault_key_injection: {
        external_provisioning_required: { reason: "x" },
      },
    };
    expect(decodeTransportCapabilities("c", asJson(external)).ok).toBe(false);
    expect(
      decodeTransportCapabilities(
        "c",
        asJson({ ...browser, server_enforces_certificate: "false" }),
      ).ok,
    ).toBe(false);
    expect(decodeCapabilityOutcome("o", "Supported").ok).toBe(false);
    expect(
      decodeCapabilityOutcome("o", { unsupported: { reason: "" } }).ok,
    ).toBe(false);
  });

  it("a view with a verified flag or a subject DN is refused, an honest one decodes", () => {
    const view = {
      source: "direct_tls",
      identities: [BRIDGE, { leaf_thumbprint_sha256: HEX_A }],
      leaf_thumbprint_sha256: HEX_A,
      not_before: "2026-09-22T00:00:00.000Z",
      not_after: "2026-09-23T00:00:00.000Z",
      trust_profile: PROFILE,
      trust_generation: 3,
      credential_generation: 7,
      listener: "host-tls",
      policy: "mtls_required",
      tls_version: "tls13",
      authenticated_at: "2026-09-22T09:59:00.000Z",
      usable_until: "2026-09-22T10:29:00.000Z",
    };
    const decoded = decodePeerEvidenceView("v", view);
    expect(decoded.ok && decoded.value.ingress).toBeNull();
    expect(decodePeerEvidenceView("v", { ...view, verified: true }).ok).toBe(
      false,
    );
    expect(decodePeerEvidenceView("v", { ...view, subject: "CN=x" }).ok).toBe(
      false,
    );
    expect(
      decodePeerEvidenceView("v", { ...view, trust_generation: "3" }).ok,
    ).toBe(false);
    expect(decodePeerEvidenceView("v", { ...view, source: "header" }).ok).toBe(
      false,
    );
  });

  it("enforcement goes stale on a generation change or after fresh_until", () => {
    const verified = {
      verified: {
        at: "2026-09-22T09:00:00.000Z",
        target: "host-tls",
        generation: 3,
        accepted_with_certificate: true,
        rejected_without_certificate: true,
        fresh_until: "2026-09-22T11:00:00.000Z",
      },
    } as const;
    expect(enforcementProven(verified)).toBe(true);
    expect(reconcileEnforcement(verified, 3, NOW)).toBe(verified);
    expect(reconcileEnforcement(verified, 4, NOW)).toEqual({
      stale: {
        verified_at: "2026-09-22T09:00:00.000Z",
        generation: 3,
        current_generation: 4,
      },
    });
    expect(
      reconcileEnforcement(verified, 3, new Date("2026-09-22T11:00:00.000Z")),
    ).toHaveProperty("stale");
    const positiveOnly = {
      verified: { ...verified.verified, rejected_without_certificate: false },
    };
    expect(enforcementProven(positiveOnly)).toBe(false);
    expect(enforcementProven("unverified")).toBe(false);
  });

  it("status views bind observations and probes to their target", () => {
    const status = {
      target: "worker-tls",
      desired: "existing_local",
      credential: "unconfigured",
      runtime: "not_loaded",
      enforcement: "unverified",
      capabilities: browserTransportCapabilities(),
    };
    const decoded = decodeTransportStatusView(asJson(status));
    expect(decoded.ok && decoded.value.observed).toBeNull();
    expect(
      decodeTransportStatusView(asJson({ ...status, status: "healthy" })).ok,
    ).toBe(false);
    expect(
      decodeTransportStatusView(asJson({ ...status, credential: "healthy" }))
        .ok,
    ).toBe(false);
    expect(
      decodeTransportStatusView(
        asJson({
          ...status,
          runtime: { reload_failed: { generation: 1, code: "network error" } },
        }),
      ).ok,
    ).toBe(false);
    expect(
      decodeTransportStatusView(
        asJson({
          ...status,
          runtime: {
            reload_failed: { generation: 1, code: "key_pair_mismatch" },
          },
        }),
      ).ok,
    ).toBe(true);
    expect(
      decodeTransportStatusView(
        asJson({
          ...status,
          enforcement: {
            verified: {
              at: "2026-09-22T09:00:00.000Z",
              target: "host-tls",
              generation: 1,
              accepted_with_certificate: true,
              rejected_without_certificate: true,
              fresh_until: "2026-09-22T11:00:00.000Z",
            },
          },
        }),
      ).ok,
    ).toBe(false);
    expect(TRANSPORT_ERROR_CODES).toContain("forwarded_evidence_unverified");
    expect(TRANSPORT_ERROR_CODES).toHaveLength(17);
  });
});
