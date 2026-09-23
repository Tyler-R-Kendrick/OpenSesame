import { describe, expect, it } from "vitest";
import {
  browserCapabilities,
  isTransportPolicy,
  parseTransportStatusView,
} from "./transport-model.js";
import { transportStatusWire } from "./transport-status.fixture.js";

describe("parseTransportStatusView", () => {
  it("reads the whole wire shape and keeps the five dimensions apart", () => {
    const view = parseTransportStatusView(transportStatusWire());
    expect(view).not.toBeNull();
    expect(view?.target).toBe("host-tls");
    expect(view?.desired).toBe("mtls_required");
    expect(view?.credential).toMatchObject({
      kind: "configured",
      custody: "host_sealed_exportable_to_host",
      source: "managed_certificate",
      generation: 3,
    });
    // Timestamps come back canonical: UTC, millisecond precision, `Z`.
    expect(view?.runtime).toEqual({
      kind: "loaded",
      generation: 3,
      loaded_at: "2026-09-22T10:00:00.000Z",
    });
    expect(view?.observed?.observer).toBe("transport.probe");
    expect(view?.enforcement).toMatchObject({
      kind: "verified",
      rejected_without_certificate: true,
    });
    expect(view?.capabilities.browser_vault_key_injection).toEqual({
      kind: "unsupported",
      reason: "never",
    });
  });

  it("reads every unit variant as its bare name", () => {
    const view = parseTransportStatusView(
      transportStatusWire({
        credential: "unconfigured",
        runtime: "not_loaded",
        observed: null,
        enforcement: "unverified",
      }),
    );
    expect(view?.credential).toEqual({ kind: "unconfigured" });
    expect(view?.runtime).toEqual({ kind: "not_loaded" });
    expect(view?.observed).toBeNull();
    expect(view?.enforcement).toEqual({ kind: "unverified" });
  });

  it("reads expired, revoked, reload_failed and stale", () => {
    const view = parseTransportStatusView(
      transportStatusWire({
        credential: { revoked: { generation: 2 } },
        runtime: {
          reload_failed: { generation: 3, code: "key_pair_mismatch" },
        },
        enforcement: {
          stale: {
            verified_at: "2026-09-22T09:00:00Z",
            generation: 2,
            current_generation: 3,
          },
        },
      }),
    );
    expect(view?.credential).toEqual({ kind: "revoked", generation: 2 });
    expect(view?.runtime).toMatchObject({ kind: "reload_failed" });
    expect(view?.enforcement).toMatchObject({
      kind: "stale",
      current_generation: 3,
    });
    expect(
      parseTransportStatusView(
        transportStatusWire({ credential: { expired: { generation: 1 } } }),
      )?.credential,
    ).toEqual({ kind: "expired", generation: 1 });
  });

  it.each([
    ["unknown policy", { desired: "mtls_optional" }],
    ["unknown credential variant", { credential: "healthy" }],
    [
      "two tags at once",
      {
        runtime: {
          loaded: { generation: 1, loaded_at: "2026-09-22T10:00:00Z" },
          not_loaded: {},
        },
      },
    ],
    [
      "string boolean",
      {
        enforcement: {
          verified: {
            at: "2026-09-22T11:00:00Z",
            target: "t",
            generation: 3,
            accepted_with_certificate: "true",
            rejected_without_certificate: true,
            fresh_until: "2026-09-22T13:00:00Z",
          },
        },
      },
    ],
    [
      "fractional generation",
      {
        runtime: {
          loaded: { generation: 1.5, loaded_at: "2026-09-22T10:00:00Z" },
        },
      },
    ],
    [
      "negative generation",
      {
        runtime: {
          loaded: { generation: -1, loaded_at: "2026-09-22T10:00:00Z" },
        },
      },
    ],
    [
      "epoch number as timestamp",
      { runtime: { loaded: { generation: 1, loaded_at: 1758542400 } } },
    ],
    [
      "not a timestamp",
      { runtime: { loaded: { generation: 1, loaded_at: "yesterday" } } },
    ],
    [
      "observed missing peer",
      {
        observed: {
          at: "2026-09-22T11:00:00Z",
          observer: "o",
          target: "t",
          generation: 3,
        },
      },
    ],
    ["empty target", { target: "" }],
    [
      "unknown custody",
      {
        credential: {
          configured: {
            custody: "hardware",
            generation: 3,
            not_after: "2026-12-01T00:00:00Z",
            kind: "pem_files",
          },
        },
      },
    ],
    [
      "capability outcome without reason",
      {
        capabilities: {
          native_pem: { unsupported: {} },
          managed_certificate: "supported",
          spiffe_workload_api: "supported",
          browser_managed_external: "supported",
          browser_vault_key_injection: "supported",
          client_presents_certificate: false,
          server_enforces_certificate: false,
        },
      },
    ],
  ])("refuses %s", (_name, overrides) => {
    expect(parseTransportStatusView(transportStatusWire(overrides))).toBeNull();
  });

  it("refuses anything that is not an object", () => {
    expect(parseTransportStatusView("mtls_required")).toBeNull();
    expect(parseTransportStatusView(null)).toBeNull();
    expect(parseTransportStatusView([])).toBeNull();
  });
});

describe("browserCapabilities", () => {
  it("is the os-domain browser profile lifted: nothing native, no key injection, enforces nothing", () => {
    const caps = browserCapabilities();
    expect(caps.browser_vault_key_injection.kind).toBe("unsupported");
    expect(caps.browser_managed_external.kind).toBe(
      "external_provisioning_required",
    );
    expect(caps.native_pem.kind).toBe("unsupported");
    expect(caps.client_presents_certificate).toBe(false);
    expect(caps.server_enforces_certificate).toBe(false);
  });
});

describe("isTransportPolicy", () => {
  it("names exactly the four policies", () => {
    for (const policy of [
      "existing_local",
      "server_tls",
      "mtls_required",
      "trusted_ingress",
    ]) {
      expect(isTransportPolicy(policy)).toBe(true);
    }
    expect(isTransportPolicy("auto")).toBe(false);
    expect(isTransportPolicy(1)).toBe(false);
  });
});
