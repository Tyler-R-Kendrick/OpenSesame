import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createOpenSesameProvider } from "../create-provider.js";
import {
  type MtlsPeer,
  buildMtlsFeature,
  certificateSubjectMatches,
  mtlsClientAuthMethods,
  mtlsClientFence,
  mtlsDiscovery,
} from "../mtls/feature.js";

describe("RFC 8705 feature (unit)", () => {
  it("is disabled without a transport and advertises nothing", () => {
    expect(buildMtlsFeature(undefined)).toEqual({ mTLS: { enabled: false } });
    expect(mtlsDiscovery(undefined)).toBeUndefined();
    const { provider } = createOpenSesameProvider({
      issuer: "https://op.example",
    });
    expect(provider).toBeDefined();
  });

  it("lists tls_client_auth among client auth methods only with a transport", () => {
    expect(mtlsClientAuthMethods(undefined).clientAuthMethods).not.toContain(
      "tls_client_auth",
    );
    expect(
      mtlsClientAuthMethods({ peerOf: () => undefined }).clientAuthMethods,
    ).toContain("tls_client_auth");
    expect(
      mtlsClientAuthMethods({ peerOf: () => undefined }).clientAuthMethods,
    ).not.toContain("self_signed_tls_client_auth");
  });

  it("enables PKI client auth and bound tokens with a transport, never self-signed", () => {
    const feature = buildMtlsFeature({ peerOf: () => undefined }).mTLS;
    expect(feature).toMatchObject({
      enabled: true,
      certificateBoundAccessTokens: true,
      tlsClientAuth: true,
      selfSignedTlsClientAuth: false,
    });
  });

  it("advertises endpoint aliases only with a distinct public base", () => {
    expect(mtlsDiscovery({ peerOf: () => undefined })).toBeUndefined();
    expect(
      mtlsDiscovery({
        peerOf: () => undefined,
        endpointAliasBase: "https://mtls.op.example/",
      }),
    ).toEqual({
      mtls_endpoint_aliases: {
        token_endpoint: "https://mtls.op.example/token",
        userinfo_endpoint: "https://mtls.op.example/me",
        introspection_endpoint: "https://mtls.op.example/token/introspection",
        revocation_endpoint: "https://mtls.op.example/token/revocation",
        device_authorization_endpoint: "https://mtls.op.example/device/auth",
        pushed_authorization_request_endpoint:
          "https://mtls.op.example/request",
      },
    });
  });

  it("matches SAN DNS and URI exactly; never CN, wildcard, DN, IP or email", () => {
    const peer: MtlsPeer = {
      certificatePem: () => "",
      dnsNames: () => ["host.mapping.example"],
      uris: () => ["spiffe://td.example/host"],
    };
    expect(
      certificateSubjectMatches(
        peer,
        "tls_client_auth_san_dns",
        "host.mapping.example",
      ),
    ).toBe(true);
    expect(
      certificateSubjectMatches(
        peer,
        "tls_client_auth_san_dns",
        "HOST.mapping.example",
      ),
    ).toBe(true);
    expect(
      certificateSubjectMatches(
        peer,
        "tls_client_auth_san_dns",
        "*.mapping.example",
      ),
    ).toBe(false);
    expect(
      certificateSubjectMatches(
        peer,
        "tls_client_auth_san_dns",
        "mapping.example",
      ),
    ).toBe(false);
    expect(
      certificateSubjectMatches(
        peer,
        "tls_client_auth_san_uri",
        "spiffe://td.example/host",
      ),
    ).toBe(true);
    expect(
      certificateSubjectMatches(
        peer,
        "tls_client_auth_san_uri",
        "spiffe://td.example/",
      ),
    ).toBe(false);
    expect(
      certificateSubjectMatches(peer, "tls_client_auth_subject_dn", "CN=host"),
    ).toBe(false);
    expect(
      certificateSubjectMatches(peer, "tls_client_auth_san_ip", "127.0.0.1"),
    ).toBe(false);
    expect(
      certificateSubjectMatches(peer, "tls_client_auth_san_email", "a@b"),
    ).toBe(false);
    expect(
      certificateSubjectMatches(
        undefined,
        "tls_client_auth_san_dns",
        "host.mapping.example",
      ),
    ).toBe(false);
  });

  it("fences request-driven admission out of certificate auth and bound tokens", () => {
    const fence = mtlsClientFence();
    const refused: string[] = [];
    const meta = (extra: JsonObject) => ({
      ...extra,
      invalidate: (m: string) => refused.push(m),
    });
    // A request context (DCR / CIMD) may not claim either capability.
    fence.validator(
      { oidc: {} },
      "os_mtls_fence",
      undefined,
      meta({ token_endpoint_auth_method: "tls_client_auth" }),
    );
    fence.validator(
      { oidc: {} },
      "os_mtls_fence",
      undefined,
      meta({ tls_client_certificate_bound_access_tokens: true }),
    );
    expect(refused).toHaveLength(2);
    // Static and store-loaded clients carry no ctx and are the admin path.
    fence.validator(
      undefined,
      "os_mtls_fence",
      undefined,
      meta({ token_endpoint_auth_method: "tls_client_auth" }),
    );
    fence.validator(
      { oidc: {} },
      "os_mtls_fence",
      undefined,
      meta({ token_endpoint_auth_method: "none" }),
    );
    expect(refused).toHaveLength(2);
  });
});
