import { describe, expect, it } from "vitest";
import { fuzz as fuzzAgentAuthContracts } from "./agent_auth_contracts.js";
import { fuzz as fuzzAgentAuthTokens } from "./agent_auth_tokens.js";
import { fuzz as fuzzAuditRedact } from "./audit_redact.js";
import { fuzz as fuzzClaimEngine } from "./claim_engine.js";
import { fuzz as fuzzClientAdmission } from "./client_admission.js";
import { fuzz as fuzzContractsParse } from "./contracts_parse.js";
import { fuzz as fuzzEndpointDisplay } from "./endpoint_display.js";
import { fuzz as fuzzEnvSpecBridge } from "./env_spec_bridge.js";
import { fuzz as fuzzOriginNormalize } from "./origin_normalize.js";
import { fuzz as fuzzOsDomain } from "./os_domain.js";
import {
  fuzz as fuzzProvisionalIdentity,
  seedProvisional,
} from "./provisional_identity.js";
import { fuzz as fuzzSafeMetadataUrl } from "./safe_metadata_url.js";
import { fuzz as fuzzTaskbusContract } from "./taskbus_contract.js";
import { fuzz as fuzzWebauthnCeremony } from "./webauthn_ceremony.js";

/** Big-endian uint32 words the provider consumes for integral ranges. */
function word(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

describe("agent_auth_tokens fuzz target", () => {
  it("never throws on arbitrary bytes and rejects product prefixes", () => {
    expect(() =>
      fuzzAgentAuthTokens(Buffer.from("random fuzz bytes")),
    ).not.toThrow();
    expect(() => fuzzAgentAuthTokens(Buffer.alloc(0))).not.toThrow();
    expect(() =>
      fuzzAgentAuthTokens(Buffer.from("osc_clm_id.secret")),
    ).not.toThrow();
    expect(() =>
      fuzzAgentAuthTokens(Buffer.from("clm_id.secret")),
    ).not.toThrow();
    expect(() =>
      fuzzAgentAuthTokens(Buffer.from("clat_id.secret")),
    ).not.toThrow();
    expect(() =>
      fuzzAgentAuthTokens(Buffer.from("aat_id.secret")),
    ).not.toThrow();
  });
});

describe("agent_auth_contracts fuzz target", () => {
  it("accepts anonymous and rejects mixed-type bodies", () => {
    expect(() =>
      fuzzAgentAuthContracts(
        Buffer.from(JSON.stringify({ type: "anonymous" })),
      ),
    ).not.toThrow();
    expect(() =>
      fuzzAgentAuthContracts(
        Buffer.from(
          JSON.stringify({ type: "service_auth", login_hint: "a@b.c" }),
        ),
      ),
    ).not.toThrow();
    expect(() => fuzzAgentAuthContracts(Buffer.from("{nope"))).not.toThrow();
    expect(() =>
      fuzzAgentAuthContracts(
        Buffer.from(JSON.stringify({ type: "service_auth", login_hint: "" })),
      ),
    ).not.toThrow();
  });
});

describe("audit_redact fuzz target", () => {
  it("redacts static secret fields regardless of fuzzed action/reason", () => {
    expect(() =>
      fuzzAuditRedact(Buffer.from("random fuzz bytes")),
    ).not.toThrow();
    expect(() => fuzzAuditRedact(Buffer.alloc(0))).not.toThrow();
  });
});

describe("endpoint_display fuzz target", () => {
  it("shortens anything a person can type without throwing", () => {
    for (const seed of [
      "",
      "http://127.0.0.1:18787/",
      "https://box.tailnet.ts.net/host",
      "https://github.com/owner/store.git",
      "git@github.com:owner/store.git",
      "not a url",
      "://////",
      "http://[::1]:1/../..",
      "\u0000\u0000",
      "a".repeat(512),
    ]) {
      expect(() => fuzzEndpointDisplay(Buffer.from(seed))).not.toThrow();
    }
    expect(() => fuzzEndpointDisplay(Buffer.alloc(0))).not.toThrow();
  });
});

describe("claim_engine fuzz target", () => {
  it("keeps terminal states terminal for every terminal source", () => {
    // state order: pending, presented, authenticated, reviewed, completed,
    // denied, revoked, expired — index via uint32 % 8
    for (const terminal of [4, 5, 6] as const) {
      for (let to = 0; to < 8; to += 1) {
        const data = Buffer.from([...word(terminal), ...word(to)]);
        expect(() => fuzzClaimEngine(data)).not.toThrow();
      }
    }
  });

  it("allows non-terminal transitions the state machine permits", () => {
    // pending -> presented is a legitimate transition
    const data = Buffer.from([...word(0), ...word(1)]);
    expect(() => fuzzClaimEngine(data)).not.toThrow();
  });
});

describe("client_admission fuzz target", () => {
  const build = (
    flags: [boolean, boolean, boolean],
    modeIndex: number,
    scopes: string,
    active: boolean,
  ): Buffer =>
    // consumeString(32) reads exactly 32 bytes, so the scope field is padded
    Buffer.from([
      ...flags.map((f) => (f ? 1 : 0)),
      ...word(modeIndex),
      ...Buffer.from(scopes.padEnd(32, " "), "utf8"),
      active ? 1 : 0,
    ]);

  it("admits an active pre-registered client", () => {
    expect(() =>
      fuzzClientAdmission(build([true, true, true], 0, "openid", true)),
    ).not.toThrow();
  });

  it("rejects a suspended client and swallows the admission error", () => {
    expect(() =>
      fuzzClientAdmission(build([true, true, true], 0, "openid", false)),
    ).not.toThrow();
  });

  it("rejects a client whose admission mode is disabled", () => {
    // origin_profile (index 1) with originClientsEnabled = false
    expect(() =>
      fuzzClientAdmission(build([false, true, true], 1, "openid", true)),
    ).not.toThrow();
  });

  it("handles an empty fuzz buffer", () => {
    expect(() => fuzzClientAdmission(Buffer.alloc(0))).not.toThrow();
  });
});

describe("contracts_parse fuzz target", () => {
  it("returns early on invalid JSON", () => {
    expect(() => fuzzContractsParse(Buffer.from("not json{"))).not.toThrow();
  });

  it("ignores JSON that fails the schema", () => {
    expect(() => fuzzContractsParse(Buffer.from("{}"))).not.toThrow();
    expect(() =>
      fuzzContractsParse(
        Buffer.from(JSON.stringify({ type: "bogus", targetManifest: {} })),
      ),
    ).not.toThrow();
  });

  it("accepts a valid claim request without a ttl", () => {
    const body = JSON.stringify({ type: "principal", targetManifest: {} });
    expect(() => fuzzContractsParse(Buffer.from(body))).not.toThrow();
  });

  it("accepts a valid claim request with an in-range ttl", () => {
    const body = JSON.stringify({
      type: "device",
      targetManifest: { os: "linux" },
      ttlSeconds: 60,
    });
    expect(() => fuzzContractsParse(Buffer.from(body))).not.toThrow();
  });
});

describe("env_spec_bridge fuzz target", () => {
  it("parses ordinary assignments without findings", () => {
    expect(() => fuzzEnvSpecBridge(Buffer.from("FOO=bar\n"))).not.toThrow();
  });

  it("handles annotations without sensitive values", () => {
    expect(() =>
      fuzzEnvSpecBridge(Buffer.from("# @sensitive\nFOO=bar\n")),
    ).not.toThrow();
  });

  it("flags a sensitive value that survives into the parsed output", () => {
    // the parser retains the annotated value, so the oracle must fire and the
    // target must rethrow the "leaked" error rather than swallow it
    expect(() =>
      fuzzEnvSpecBridge(Buffer.from("API_KEY=SUPERSECRET # @sensitive\n")),
    ).toThrow(/leaked from env-spec parse/);
  });

  it("swallows parser errors for malformed documents", () => {
    expect(() =>
      fuzzEnvSpecBridge(Buffer.from([0xff, 0xfe, 0x00, 0x01])),
    ).not.toThrow();
  });
});

describe("origin_normalize fuzz target", () => {
  const build = (raw: string, issuer = ""): Buffer => {
    const rawField = raw.padEnd(64, " ");
    return Buffer.from(rawField + issuer, "utf8");
  };

  it("canonicalizes a plain resource deterministically", () => {
    expect(() =>
      fuzzOriginNormalize(build("https://api.example/foo")),
    ).not.toThrow();
  });

  it("accepts the issuer as its own audience", () => {
    expect(() =>
      fuzzOriginNormalize(build("https://idp.example", "https://idp.example")),
    ).not.toThrow();
  });

  it("treats resources carrying a query as non-canonical", () => {
    expect(() =>
      fuzzOriginNormalize(build("https://api.example/foo?x=1")),
    ).not.toThrow();
  });

  it("treats non-URL input as non-canonical", () => {
    expect(() => fuzzOriginNormalize(Buffer.from("::::"))).not.toThrow();
    expect(() => fuzzOriginNormalize(Buffer.alloc(0))).not.toThrow();
  });
});

describe("os_domain fuzz target", () => {
  it("accepts a principal upgrade that keeps the id", () => {
    // consumeString(16) reads exactly 16 bytes, so the id field is padded
    const data = Buffer.concat([
      Buffer.from("prn_stable".padEnd(16, " "), "utf8"),
      Buffer.from([1]),
    ]);
    expect(() => fuzzOsDomain(data)).not.toThrow();
  });

  it("swallows the domain error when the id changes", () => {
    const data = Buffer.concat([
      Buffer.from("prn_mutable".padEnd(16, " "), "utf8"),
      Buffer.from([0]),
    ]);
    expect(() => fuzzOsDomain(data)).not.toThrow();
  });

  it("falls back to a default id on an empty buffer", () => {
    expect(() => fuzzOsDomain(Buffer.alloc(0))).not.toThrow();
  });
});

describe("provisional_identity fuzz target", () => {
  it("never authenticates a bare provisional session id", () => {
    expect(() =>
      fuzzProvisionalIdentity(Buffer.from("ps_0123456789")),
    ).not.toThrow();
  });

  it("ignores tokens and unrelated strings", () => {
    expect(() =>
      fuzzProvisionalIdentity(Buffer.from("pst_real_token")),
    ).not.toThrow();
    expect(() =>
      fuzzProvisionalIdentity(Buffer.from("unrelated")),
    ).not.toThrow();
    expect(() => fuzzProvisionalIdentity(Buffer.alloc(0))).not.toThrow();
  });

  it("seeds a provisional principal whose session id cannot authenticate", async () => {
    await expect(seedProvisional()).resolves.toBeUndefined();
  });
});

describe("safe_metadata_url fuzz target", () => {
  it("accepts a public https metadata URL", () => {
    expect(() =>
      fuzzSafeMetadataUrl(Buffer.from("https://example.com/metadata.json")),
    ).not.toThrow();
  });

  it("rejects loopback and metadata hosts via the safe fetcher", () => {
    expect(() =>
      fuzzSafeMetadataUrl(Buffer.from("http://localhost/hoard")),
    ).not.toThrow();
    expect(() =>
      fuzzSafeMetadataUrl(Buffer.from("http://169.254.169.254/latest")),
    ).not.toThrow();
  });

  it("rejects unparseable and unsupported-protocol URLs", () => {
    expect(() => fuzzSafeMetadataUrl(Buffer.from("not a url"))).not.toThrow();
    expect(() =>
      fuzzSafeMetadataUrl(Buffer.from("ftp://example.com/x")),
    ).not.toThrow();
  });
});

describe("taskbus_contract fuzz target", () => {
  it("returns early on invalid JSON", () => {
    expect(() => fuzzTaskbusContract(Buffer.from("{nope"))).not.toThrow();
  });

  it("accepts a clean memory-backed config", () => {
    const body = JSON.stringify({
      backend: "memory",
      source: "default",
      status: "ok",
    });
    expect(() => fuzzTaskbusContract(Buffer.from(body))).not.toThrow();
  });

  it("accepts a nats config with a nats:// URL", () => {
    const body = JSON.stringify({
      backend: "nats",
      nats_url: "nats://nats.example:4222",
      source: "stored",
      status: "connected",
      last_error: null,
    });
    expect(() => fuzzTaskbusContract(Buffer.from(body))).not.toThrow();
  });

  it("accepts a GET response wrapper for the memory backend", () => {
    const body = JSON.stringify({
      taskbus: { backend: "memory", source: "env", status: "ok" },
    });
    expect(() => fuzzTaskbusContract(Buffer.from(body))).not.toThrow();
  });

  it("accepts PUT requests with and without a nats_url", () => {
    expect(() =>
      fuzzTaskbusContract(
        Buffer.from(
          JSON.stringify({ backend: "nats", nats_url: "tls://nats:4222" }),
        ),
      ),
    ).not.toThrow();
    expect(() =>
      fuzzTaskbusContract(Buffer.from(JSON.stringify({ backend: "nats" }))),
    ).not.toThrow();
    expect(() =>
      fuzzTaskbusContract(Buffer.from(JSON.stringify({ backend: "memory" }))),
    ).not.toThrow();
  });
});

describe("webauthn_ceremony fuzz target", () => {
  it("consumes a stored challenge exactly once", () => {
    expect(() =>
      fuzzWebauthnCeremony(Buffer.from("challenge-bytes")),
    ).not.toThrow();
  });

  it("falls back to a default challenge on an empty buffer", () => {
    expect(() => fuzzWebauthnCeremony(Buffer.alloc(0))).not.toThrow();
  });
});
