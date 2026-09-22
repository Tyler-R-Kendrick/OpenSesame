import { describe, expect, it } from "vitest";
import type { JsonValue } from "../json.js";
import {
  type BINDING_PURPOSES,
  type BindingScope,
  type PeerIdentitySelector,
  type ServiceBinding,
  type ServiceBindingSet,
  TRANSPORT_ERROR_CODES,
  TRANSPORT_OPERATIONS,
  browserTransportCapabilities,
  canonicalTimestamp,
  decodeBindingScope,
  decodeCapabilityOutcome,
  decodePeerEvidenceView,
  decodeSelector,
  decodeServiceBindingSet,
  decodeTransportCapabilities,
  decodeTransportStatusView,
  decodeTrustProfileRef,
  enforcementProven,
  isValidId,
  parseRfc3339,
  parseServiceBindingSet,
  reconcileEnforcement,
  resolveServiceBinding,
} from "../transport-security/index.js";

const HEX_A = "a".repeat(64);

/** Domain values are readonly; the decoders read plain JSON. */
function asJson<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value));
}
const HEX_B = "b".repeat(64);
const NOW = new Date("2026-09-22T10:00:00.000Z");
const BRIDGE: PeerIdentitySelector = {
  spiffe_id: "spiffe://example.org/ns/prod/sa/nats-bridge",
};
const PROFILE = { name: "private-root" };

function binding(over: Partial<ServiceBinding> = {}): ServiceBinding {
  return {
    id: "bridge",
    revision: 1,
    enabled: true,
    revoked: false,
    scope: "deployment",
    trust_profile: PROFILE,
    peer: BRIDGE,
    service_principal: "svc:nats-bridge",
    purpose: "nats_auth_bridge",
    allowed_operations: [TRANSPORT_OPERATIONS.natsCalloutDecide],
    allowed_audiences: ["host"],
    not_after: null,
    denied_thumbprints: [],
    ...over,
  };
}

function set(...bindings: ServiceBinding[]): ServiceBindingSet {
  return { revision: 1, bindings };
}

const PRESENTED: PeerIdentitySelector[] = [
  BRIDGE,
  { leaf_thumbprint_sha256: HEX_A },
];

function resolve(
  bindings: ServiceBindingSet,
  purpose: (typeof BINDING_PURPOSES)[number] = "nats_auth_bridge",
  scope: BindingScope = "deployment",
  presented: readonly PeerIdentitySelector[] = PRESENTED,
): string {
  const result = resolveServiceBinding(
    bindings,
    scope,
    PROFILE,
    presented,
    purpose,
    NOW,
  );
  return result.ok ? `ok:${result.value.id}` : result.error.code;
}

describe("strict RFC 3339", () => {
  it("accepts canonical and offset forms, canonicalizing to UTC millis", () => {
    const parsed = parseRfc3339("2026-09-22T15:30:00+05:30");
    expect(parsed && canonicalTimestamp(parsed)).toBe(
      "2026-09-22T10:00:00.000Z",
    );
    expect(parseRfc3339("2026-09-22T10:00:00.5Z")?.toISOString()).toBe(
      "2026-09-22T10:00:00.500Z",
    );
    expect(parseRfc3339("0099-01-01T00:00:00Z")?.toISOString()).toBe(
      "0099-01-01T00:00:00.000Z",
    );
  });

  it("refuses what V8 would silently accept", () => {
    for (const bad of [
      "2026-09-22T10:00:00",
      "2026-09-22 10:00:00Z",
      "2026-09-22t10:00:00z",
      "2026-09-22T10:00:00.1234Z",
      "2026-09-22T23:59:60Z",
      "2026-09-22T10:00:00+0530",
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:00:00+24:00",
      "2027-02-29T00:00:00Z",
      "",
    ]) {
      expect(parseRfc3339(bad), bad).toBeNull();
    }
    expect(parseRfc3339("2028-02-29T00:00:00Z")).not.toBeNull();
  });
});

describe("selectors and references", () => {
  it("decodes well-formed selectors and refuses malformed ones", () => {
    for (const good of [
      BRIDGE,
      { dns_name: "gateway.internal.example" },
      { uri_san: "urn:opensesame:worker:alpha" },
      { leaf_thumbprint_sha256: HEX_A },
    ]) {
      expect(decodeSelector("peer", good)).toEqual({ ok: true, value: good });
    }
    const bad: JsonValue[] = [
      { dns_name: "Gateway.Example" },
      { dns_name: "*.example" },
      { dns_name: "gateway.example." },
      { dns_name: "10.0.0.1" },
      { dns_name: "fe80::1" },
      { dns_name: "user@example.com" },
      { dns_name: `${"a".repeat(250)}.example` },
      { common_name: "gateway" },
      { email: "ops@example.com" },
      { spiffe_id: "spiffe://example.org" },
      { spiffe_id: "spiffe://Example.org/x" },
      { spiffe_id: "spiffe://exаmple.org/x" },
      { spiffe_id: "spiffe://example.org/x/../y" },
      { spiffe_id: `spiffe://td/${"a".repeat(2048)}` },
      { uri_san: "spiffe://example.org/x" },
      { uri_san: "mailto:ops@example.com" },
      { uri_san: "no-scheme" },
      { leaf_thumbprint_sha256: HEX_A.toUpperCase() },
      { dns_name: "a.example", uri_san: "urn:x" },
      "gateway.example",
      { dns_name: 1 },
      {},
    ];
    for (const value of bad) {
      const result = decodeSelector("peer", value);
      expect(result.ok, JSON.stringify(value)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("malformed_configuration");
    }
  });

  it("references and ids follow the shared grammars", () => {
    expect(decodeTrustProfileRef("p", { name: "private-root" }).ok).toBe(true);
    for (const value of [
      { name: "Upper" },
      { name: "" },
      { name: "-x" },
      { name: "x".repeat(65) },
      { name: "p", path: "/etc/ca.pem" },
      "private-root",
    ]) {
      expect(decodeTrustProfileRef("p", value).ok, JSON.stringify(value)).toBe(
        false,
      );
    }
    expect(isValidId("svc:a")).toBe(true);
    expect(isValidId("a b")).toBe(false);
    expect(isValidId("x".repeat(129))).toBe(false);
    expect(isValidId("ünï")).toBe(false);
    expect(decodeBindingScope("s", "deployment")).toEqual({
      ok: true,
      value: "deployment",
    });
    expect(decodeBindingScope("s", "organization").ok).toBe(false);
    expect(
      decodeBindingScope("s", { organization: { organization_id: "" } }).ok,
    ).toBe(false);
  });
});

describe("service binding resolution (default deny)", () => {
  it("empty set, wrong purpose, wrong profile, sibling path", () => {
    expect(resolve(set())).toBe("peer_not_bound");
    expect(resolve(set(binding()))).toBe("ok:bridge");
    expect(resolve(set(binding()), "worker_client")).toBe("peer_not_bound");
    expect(
      resolve(set(binding()), "nats_auth_bridge", "deployment", [
        { spiffe_id: "spiffe://example.org/ns/prod/sa/nats-bridge-2" },
      ]),
    ).toBe("peer_not_bound");
    expect(resolve(set(binding()), "nats_auth_bridge", "deployment", [])).toBe(
      "peer_not_bound",
    );
  });

  it("disabled, revoked, expired → binding_disabled; boundary is exclusive", () => {
    expect(resolve(set(binding({ enabled: false })))).toBe("binding_disabled");
    expect(resolve(set(binding({ revoked: true })))).toBe("binding_disabled");
    expect(
      resolve(set(binding({ not_after: "2026-09-22T09:59:59.000Z" }))),
    ).toBe("binding_disabled");
    expect(
      resolve(set(binding({ not_after: "2026-09-22T10:00:00.000Z" }))),
    ).toBe("binding_disabled");
    expect(
      resolve(set(binding({ not_after: "2026-09-22T10:00:01.000Z" }))),
    ).toBe("ok:bridge");
  });

  it("ambiguity is an error, never first-wins", () => {
    expect(resolve(set(binding(), binding({ id: "bridge-2" })))).toBe(
      "ambiguous_binding",
    );
    expect(
      resolve(
        set(
          binding({ id: "by-thumb", peer: { leaf_thumbprint_sha256: HEX_A } }),
          binding(),
        ),
      ),
    ).toBe("ambiguous_binding");
    expect(
      resolve(set(binding({ id: "old", enabled: false }), binding())),
    ).toBe("ok:bridge");
  });

  it("denied thumbprints revoke a leaf even under a name binding", () => {
    expect(resolve(set(binding({ denied_thumbprints: [HEX_A] })))).toBe(
      "evidence_revoked",
    );
    expect(resolve(set(binding({ denied_thumbprints: [HEX_B] })))).toBe(
      "ok:bridge",
    );
    expect(
      resolve(
        set(
          binding({ enabled: false, denied_thumbprints: [HEX_A] }),
          binding({ id: "bridge-2" }),
        ),
      ),
    ).toBe("evidence_revoked");
  });

  it("tenant scopes are disjoint unless explicitly scoped", () => {
    const org = binding({
      id: "org-bridge",
      scope: { organization: { organization_id: "org-a" } },
    });
    const orgA: BindingScope = { organization: { organization_id: "org-a" } };
    const orgB: BindingScope = { organization: { organization_id: "org-b" } };
    expect(resolve(set(org))).toBe("peer_not_bound");
    expect(resolve(set(org), "nats_auth_bridge", orgA)).toBe("ok:org-bridge");
    expect(resolve(set(org), "nats_auth_bridge", orgB)).toBe("peer_not_bound");
    expect(resolve(set(binding()), "nats_auth_bridge", orgA)).toBe(
      "peer_not_bound",
    );
  });

  it("decoding refuses unknown fields, coercion, and structural faults", () => {
    const base = JSON.parse(JSON.stringify(set(binding())));
    expect(decodeServiceBindingSet(base).ok).toBe(true);
    const mutate = (path: string, value: JsonValue): boolean => {
      const doc = JSON.parse(JSON.stringify(base));
      const keys = path.split(".");
      const last = keys.pop();
      let cursor = doc;
      for (const key of keys) cursor = cursor[key];
      if (last !== undefined) cursor[last] = value;
      return decodeServiceBindingSet(doc).ok;
    };
    const cases: [string, JsonValue][] = [
      ["bindings.0.enabled", "true"],
      ["bindings.0.enabled", 1],
      ["bindings.0.revision", "1"],
      ["bindings.0.revision", 1.5],
      ["bindings.0.revision", 0],
      ["bindings.0.purpose", "fleet_admin"],
      ["bindings.0.scope", { tenant: { organization_id: "o" } }],
      ["bindings.0.not_after", "2026-12-01T00:00:00"],
      ["bindings.0.not_after", 1764547200],
      ["bindings.0.trust_profile", "private-root"],
      ["bindings.0.peer", { dns_name: "Bridge" }],
      ["bindings.0.allowed_operations", []],
      ["bindings.0.allowed_operations", "nats.callout.decide"],
      ["bindings.0.allowed_operations", ["a.b", "a.b"]],
      ["bindings.0.denied_thumbprints", [HEX_A.toUpperCase()]],
      ["bindings.0.role", "admin"],
      ["bindings.0.verified", true],
      ["bindings.0.id", "nats bridge"],
      ["revision", "1"],
      ["extra", 1],
    ];
    for (const [path, value] of cases) {
      expect(mutate(path, value), `${path}=${JSON.stringify(value)}`).toBe(
        false,
      );
    }
    expect(mutate("bindings.0.not_after", null)).toBe(true);
    const duplicate = decodeServiceBindingSet(
      asJson(set(binding(), binding())),
    );
    expect(duplicate.ok).toBe(false);
    expect(parseServiceBindingSet("not json").ok).toBe(false);
    expect(parseServiceBindingSet("[]").ok).toBe(false);
    expect(parseServiceBindingSet(JSON.stringify(set(binding()))).ok).toBe(
      true,
    );
  });
});
