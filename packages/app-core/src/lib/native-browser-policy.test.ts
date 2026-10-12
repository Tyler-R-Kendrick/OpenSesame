import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { connectPlan, connectPlans } from "./connect-plan.js";
import { NATIVE_BROWSER_POLICY_JSON } from "./native-browser-policy.generated.js";
import {
  assertNativeBrowserMcpPolicy,
  bindNativeBrowserPolicyOrigin,
  nativeBrowserApiPolicy,
  nativeBrowserMcpPolicy,
  nativeBrowserMethodPolicy,
  nativeBrowserOAuthPolicy,
} from "./native-browser-policy.js";
import { NativeMcpSession } from "./native-mcp-protocol.js";

const authored = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../spec/connectors/browser-policy.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);
describe("audited browser-only policy", () => {
  it("compiles the single authored source without drift", () => {
    expect(JSON.parse(NATIVE_BROWSER_POLICY_JSON)).toEqual(authored);
    expect(NATIVE_BROWSER_POLICY_JSON).toBe(JSON.stringify(authored));
  });
  it("contains only TLS-verified concrete refusals with reproducible public evidence", () => {
    expect(authored.audited_origin).toBe("https://tyler-r-kendrick.github.io");
    expect(authored.rules).toHaveLength(76);
    for (const rule of authored.rules) {
      expect(rule.probe.tls_verified).toBe(true);
      expect(rule.probe.status).toBeLessThan(500);
      expect(rule.probe.url).not.toMatch(/[{}]/);
      if (rule.probe.denied_header) {
        expect(["*", authored.audited_origin]).toContain(
          rule.probe.allow_origin,
        );
        expect(rule.probe.request_header_names).toContain(
          rule.probe.denied_header,
        );
        expect(
          rule.probe.allow_headers.toLowerCase().split(/\s*,\s*/),
        ).not.toContain(rule.probe.denied_header);
        expect(rule.evidence_urls).toContain(
          "https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#protocol-version-header",
        );
      } else {
        expect(rule.probe.allow_origin).not.toBe("*");
        expect(rule.probe.allow_origin).not.toBe(authored.audited_origin);
      }
      expect(rule.probe.request_header_names.length).toBeGreaterThan(0);
      expect(rule.evidence_urls.length).toBeGreaterThan(0);
      expect(rule.reason).not.toMatch(/api[_ -]?key[=:]|Bearer /);
      expect(
        nativeBrowserMethodPolicy(
          rule.provider_id,
          rule.method,
          rule.parameters,
        ),
      ).toMatchObject({ available: false, reason: rule.reason });
    }
  });
  it("covers every finite choice before denying defaults or a whole provider", () => {
    for (const id of ["datadog", "typeform", "railway"]) {
      const method = connectPlan(id)?.methods.find(
        (entry) => entry.kind === "api-key",
      );
      if (method?.kind !== "api-key" || !method.preset)
        throw new Error("Expected compiled API contract");
      const preset = method.preset;
      for (const variant of preset.credentialVariants)
        expect(
          nativeBrowserApiPolicy(id, { credential_variant: variant.id })
            .available,
        ).toBe(false);
      for (const field of preset.templateParams)
        for (const choice of field.choices ?? [])
          expect(
            nativeBrowserApiPolicy(id, { [field.name]: choice.value })
              .available,
          ).toBe(false);
      expect(nativeBrowserApiPolicy(id).available).toBe(false);
    }
  });
  it("preserves admitted, untested dynamic, and separate MCP methods", () => {
    for (const id of [
      "notion",
      "anthropic",
      "algolia",
      "bamboohr",
      "n8n",
      "similarweb",
      "telegram",
      "assemblyai",
      "honeycomb",
      "mailgun",
    ])
      expect(nativeBrowserApiPolicy(id).available).toBe(true);
    expect(nativeBrowserOAuthPolicy("workos").available).toBe(true);
    expect(nativeBrowserOAuthPolicy("resend").available).toBe(false);
    expect(nativeBrowserMethodPolicy("resend", "mcp").available).toBe(false);
    expect(
      nativeBrowserApiPolicy("datadog", { site: "unknown.example" }).available,
    ).toBe(true);
  });
});
describe("MCP admission on the deployment origin", () => {
  const releases: (() => void)[] = [];
  afterEach(() => {
    for (const release of releases.splice(0).reverse()) release();
  });

  it("applies the measured origin rules to all 71 published public browser contracts", () => {
    const complete = connectPlans().filter(
      (plan) =>
        !plan.refused &&
        plan.methods.some(
          (method) =>
            method.kind === "mcp" &&
            method.mcp.status === "ok" &&
            method.mcp.tokenAuthMethods.includes("none") &&
            method.mcp.pkce.includes("S256") &&
            method.mcp.resourceMetadata &&
            method.mcp.discoveryUrl,
        ),
    );
    expect(complete).toHaveLength(71);
    const denied = new Set<string>(
      authored.rules
        .filter((rule: { method: string }) => rule.method === "mcp")
        .map((rule: { provider_id: string }) => rule.provider_id),
    );
    expect(denied.size).toBe(37);
    for (const plan of complete) {
      expect(nativeBrowserMcpPolicy(plan.id).available, plan.id).toBe(
        !denied.has(plan.id),
      );
    }
  });

  it("does not carry this site's MCP CORS observation onto another self-hosted origin", () => {
    expect(nativeBrowserMcpPolicy("airtable").available).toBe(false);
    releases.push(
      bindNativeBrowserPolicyOrigin(() => "https://vault.example.com"),
    );
    expect(nativeBrowserMcpPolicy("airtable").available).toBe(true);
    // Earlier global API restrictions remain explicit; an origin override is not a waiver.
    expect(nativeBrowserApiPolicy("datadog").available).toBe(false);
    expect(() => assertNativeBrowserMcpPolicy("airtable")).not.toThrow();
  });

  it("restores the audited origin without resurrecting disposed runtime bindings", () => {
    const outer = bindNativeBrowserPolicyOrigin(
      () => "https://outer.example.com",
    );
    const inner = bindNativeBrowserPolicyOrigin(() => authored.audited_origin);
    releases.push(outer, inner);
    outer();
    expect(nativeBrowserMcpPolicy("airtable").available).toBe(false);
    inner();
    expect(nativeBrowserMcpPolicy("airtable").available).toBe(false);
    expect(() => assertNativeBrowserMcpPolicy("airtable")).toThrow(/origin/);
  });
});

it("the actual MCP SDK sends the mandatory protocol header without a server session id", async () => {
  const rpcSchema = z.object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
  });
  const binding = {
    providerId: "notion",
    fingerprint: "sealed-test-proof",
    endpoint: "https://mcp.notion.com/mcp",
    resource: "https://mcp.notion.com/mcp",
    issuer: "https://mcp.notion.com",
    transport: "streamable-http" as const,
  };
  const seen: {
    method: string;
    protocol: string | null;
    session: string | null;
  }[] = [];
  const session = new NativeMcpSession(binding, {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") return new Response(null, { status: 405 });
      const rpc = rpcSchema.parse(JSON.parse(await request.text()));
      seen.push({
        method: rpc.method,
        protocol: request.headers.get("mcp-protocol-version"),
        session: request.headers.get("mcp-session-id"),
      });
      if (rpc.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      const result =
        rpc.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "Protocol-header fixture", version: "1" },
            }
          : { tools: [] };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
        { headers: { "content-type": "application/json" } },
      );
    },
    accessGrant: async () => ({ ...binding, token: "fixture-private-token" }),
    assertCurrent: () => undefined,
    authorizationRequired: async () => undefined,
  });
  try {
    await session.connect();
    expect(seen.map((row) => row.method)).toContain("tools/list");
    const subsequent = seen.filter((row) => row.method !== "initialize");
    expect(subsequent.length).toBeGreaterThan(0);
    for (const row of subsequent) {
      expect(row.protocol, row.method).toBe("2025-11-25");
      expect(row.session, row.method).toBeNull();
    }
  } finally {
    await session.dispose();
  }
});
