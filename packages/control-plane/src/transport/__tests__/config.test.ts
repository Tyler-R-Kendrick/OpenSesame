import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSecureConfig, loadConfig } from "../../config.js";
import {
  assertTransportSecure,
  loadTransportConfig,
  loadTransportMaterial,
} from "../config.js";
import {
  type DisposablePki,
  type Issued,
  createDisposablePki,
  writeBindings,
} from "./pki.js";
import { mappingBindings } from "./server-helpers.js";

describe("transport configuration", () => {
  let pki: DisposablePki;
  let server: Issued;
  let bindingsFile: string;
  beforeAll(() => {
    pki = createDisposablePki();
    server = pki.issueServer("identity");
    bindingsFile = writeBindings(pki, mappingBindings("host.mapping.example"));
  });
  afterAll(() => pki.cleanup());

  /** The listener block a parsed config must carry, or the test is wrong. */
  const listenerOf = (env: NodeJS.ProcessEnv) => {
    const listener = loadTransportConfig(env).listener;
    if (!listener) throw new Error("expected a listener block");
    return listener;
  };
  const tlsEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    OPENSESAME_TLS_LISTEN: "127.0.0.1:0",
    OPENSESAME_TLS_POLICY: "mtls_required",
    OPENSESAME_TLS_CERT_FILE: server.certPath,
    OPENSESAME_TLS_KEY_FILE: server.keyPath,
    OPENSESAME_TLS_CLIENT_CA_FILE: pki.caCertPath,
    OPENSESAME_SERVICE_BINDINGS_FILE: bindingsFile,
    ...extra,
  });

  it("parses the listener block and defaults to TLS 1.3", () => {
    const config = loadTransportConfig(tlsEnv());
    expect(config.listener).toMatchObject({
      host: "127.0.0.1",
      port: 0,
      policy: "mtls_required",
      minVersion: "tls13",
      trustProfile: "client_ca",
      serviceBindingsFile: bindingsFile,
    });
    expect(config.mappingAuth).toBe("mtls");
    expect(config.mappingAuthExplicit).toBe(false);
  });

  it("is the legacy shared-secret profile when nothing is configured", () => {
    expect(loadTransportConfig({})).toEqual({
      mappingAuth: "shared_secret",
      mappingAuthExplicit: false,
    });
  });

  it("requires an explicit policy with a listen address", () => {
    expect(() =>
      loadTransportConfig({ OPENSESAME_TLS_LISTEN: "127.0.0.1:0" }),
    ).toThrow(/OPENSESAME_TLS_POLICY/);
    expect(() =>
      loadTransportConfig(tlsEnv({ OPENSESAME_TLS_POLICY: "auto" })),
    ).toThrow(/OPENSESAME_TLS_POLICY/);
    expect(() =>
      loadTransportConfig(tlsEnv({ OPENSESAME_TLS_MIN_VERSION: "1.1" })),
    ).toThrow(/MIN_VERSION/);
    expect(() =>
      loadTransportConfig(tlsEnv({ OPENSESAME_TLS_LISTEN: "nope" })),
    ).toThrow(/host:port/);
  });

  it("refuses an ambiguous mapping mode when both a secret and a bound listener exist", () => {
    expect(() =>
      loadTransportConfig(
        tlsEnv({ OPENSESAME_MAPPING_RESOLVE_TOKEN: "s".repeat(32) }),
      ),
    ).toThrow(/OPENSESAME_MAPPING_AUTH must be set/);
    expect(
      loadTransportConfig(
        tlsEnv({
          OPENSESAME_MAPPING_RESOLVE_TOKEN: "s".repeat(32),
          OPENSESAME_MAPPING_AUTH: "mtls",
        }),
      ).mappingAuth,
    ).toBe("mtls");
    expect(() =>
      loadTransportConfig({ OPENSESAME_MAPPING_AUTH: "both" }),
    ).toThrow(/shared_secret.*mtls/);
  });

  describe("material validation", () => {
    it("loads a matching key pair, CA and bindings", () => {
      const material = loadTransportMaterial(listenerOf(tlsEnv()));
      expect(material.leaf.fingerprint256).toBe(server.cert.fingerprint256);
      expect(material.clientCa).toHaveLength(1);
      expect(material.bindings.bindings[0]?.id).toBe("host-mapping");
    });

    it("refuses a key that does not match the certificate", () => {
      const other = pki.issueServer("other");
      expect(() =>
        loadTransportMaterial(
          listenerOf(tlsEnv({ OPENSESAME_TLS_KEY_FILE: other.keyPath })),
        ),
      ).toThrow(/key_pair_mismatch/);
    });

    it("refuses a CA certificate presented as the server leaf", () => {
      const env = tlsEnv({
        OPENSESAME_TLS_CERT_FILE: pki.caCertPath,
        OPENSESAME_TLS_KEY_FILE: pki.caKeyPath,
      });
      expect(() => loadTransportMaterial(listenerOf(env))).toThrow(
        /CA certificate/,
      );
    });

    it("refuses mtls_required without a client CA (never downgrades to server_tls)", () => {
      const { OPENSESAME_TLS_CLIENT_CA_FILE: _ca, ...env } = tlsEnv();
      expect(() => loadTransportMaterial(listenerOf(env))).toThrow(
        /trust_unknown/,
      );
    });

    it("refuses a non-CA file as the client trust", () => {
      expect(() =>
        loadTransportMaterial(
          listenerOf(
            tlsEnv({ OPENSESAME_TLS_CLIENT_CA_FILE: server.certPath }),
          ),
        ),
      ).toThrow(/only CA certificates/);
    });

    it("refuses missing files and an invalid bindings document", () => {
      const missing = listenerOf(
        tlsEnv({ OPENSESAME_TLS_KEY_FILE: join(pki.dir, "nope.key") }),
      );
      expect(() => loadTransportMaterial(missing)).toThrow(/could not be read/);
      const bad = join(pki.dir, "bad-bindings.json");
      writeFileSync(
        bad,
        JSON.stringify({ revision: 1, bindings: [{ id: "x", extra: true }] }),
      );
      expect(() =>
        loadTransportMaterial(
          listenerOf(tlsEnv({ OPENSESAME_SERVICE_BINDINGS_FILE: bad })),
        ),
      ).toThrow(/bindings file is invalid/);
    });

    it("refuses trusted_ingress without an originating trust file", () => {
      expect(() =>
        loadTransportMaterial(
          listenerOf(tlsEnv({ OPENSESAME_TLS_POLICY: "trusted_ingress" })),
        ),
      ).toThrow(/ORIGINATING_TRUST_FILE/);
    });
  });

  describe("startup predicate (AT-MAPPING-STARTUP)", () => {
    const production = { isProduction: true, mappingResolveToken: "" };

    it("mtls mode boots in production without a mapping token", () => {
      const transport = loadTransportConfig(
        tlsEnv({ OPENSESAME_MAPPING_AUTH: "mtls" }),
      );
      expect(() =>
        assertTransportSecure(transport, production, {}),
      ).not.toThrow();
    });

    it("shared_secret mode in production still requires the token", () => {
      expect(() =>
        assertTransportSecure(loadTransportConfig({}), production, {}),
      ).toThrow(/OPENSESAME_MAPPING_RESOLVE_TOKEN must be set in production/);
      expect(() =>
        assertTransportSecure(
          loadTransportConfig({}),
          { ...production, mappingResolveToken: "t" },
          {},
        ),
      ).not.toThrow();
      // A hand-assembled partial config (no transport block) is the legacy profile.
      expect(() =>
        assertTransportSecure(
          undefined,
          { ...production, mappingResolveToken: "t" },
          {},
        ),
      ).not.toThrow();
    });

    it("mtls mode without a client-authenticating listener or bindings refuses to boot", () => {
      expect(() =>
        assertTransportSecure(
          loadTransportConfig({ OPENSESAME_MAPPING_AUTH: "mtls" }),
          production,
          {},
        ),
      ).toThrow(/requires OPENSESAME_TLS_LISTEN/);
      expect(() =>
        assertTransportSecure(
          loadTransportConfig(
            tlsEnv({
              OPENSESAME_MAPPING_AUTH: "mtls",
              OPENSESAME_TLS_POLICY: "server_tls",
            }),
          ),
          production,
          {},
        ),
      ).toThrow(/mtls_required or trusted_ingress/);
      const { OPENSESAME_SERVICE_BINDINGS_FILE: _bindings, ...env } = tlsEnv({
        OPENSESAME_MAPPING_AUTH: "mtls",
      });
      expect(() =>
        assertTransportSecure(loadTransportConfig(env), production, {}),
      ).toThrow(/OPENSESAME_SERVICE_BINDINGS_FILE/);
    });

    it("a configured listener with missing material refuses the boot", () => {
      const transport = loadTransportConfig(
        tlsEnv({ OPENSESAME_TLS_CERT_FILE: join(pki.dir, "gone.crt") }),
      );
      expect(() => assertTransportSecure(transport, production, {})).toThrow(
        /could not be read/,
      );
    });

    it("a non-loopback TLS listen address needs the explicit override", () => {
      const transport = loadTransportConfig(
        tlsEnv({ OPENSESAME_TLS_LISTEN: "0.0.0.0:8443" }),
      );
      expect(() => assertTransportSecure(transport, production, {})).toThrow(
        /not loopback/,
      );
      expect(() =>
        assertTransportSecure(transport, production, {
          OPENSESAME_ALLOW_NONLOCAL: "1",
        }),
      ).not.toThrow();
    });

    it("assertSecureConfig keeps every other production safeguard while booting cert-only", () => {
      const env: NodeJS.ProcessEnv = {
        OPENSESAME_ENV: "production",
        OPENSESAME_PUBLIC_URL: "https://id.example",
        OPENSESAME_ISSUER: "https://id.example",
        OPENSESAME_HOST_API: "https://host.example",
        OPENSESAME_CLAIM_PEPPER: "p".repeat(48),
        OPENSESAME_OPERATOR_TOKEN: "o".repeat(32),
        DATABASE_URL: "postgres://db.example/opensesame",
        OPENSESAME_ALLOW_NONLOCAL: "1",
        ...tlsEnv({ OPENSESAME_MAPPING_AUTH: "mtls" }),
      };
      const config = loadConfig(env);
      expect(config.mappingResolveToken).toBe("");
      expect(config.transport.mappingAuth).toBe("mtls");
      expect(() => assertSecureConfig(config, env)).not.toThrow();
      const { OPENSESAME_OPERATOR_TOKEN: _omit, ...withoutOperator } = env;
      expect(() =>
        assertSecureConfig(loadConfig(withoutOperator), withoutOperator),
      ).toThrow(/OPENSESAME_OPERATOR_TOKEN/);
    });
  });
});
