import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { projectBrowserPolicy } from "../../scripts/emit-browser-policy.mjs";
import { connectPlan, connectPlans } from "./connect-plan.js";
import { NATIVE_BROWSER_POLICY_JSON } from "./native-browser-policy.generated.js";
import {
  NativeBrowserPolicySchema,
  assertNativeBrowserMcpPolicy,
  bindNativeBrowserPolicyOrigin,
  nativeBrowserApiPolicy,
  nativeBrowserMcpPolicy,
  nativeBrowserMethodPolicy,
  nativeBrowserOAuthPolicy,
} from "./native-browser-policy.js";
import { NATIVE_BROWSER_POLICY_RUNTIME_JSON } from "./native-browser-policy.runtime.generated.js";
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
/**
 * The probes added with the connector bridge (ADR 0218): Tailscale's API and
 * Bitwarden's identity and API servers, in both regions, answer this site
 * with no Access-Control-Allow-Origin header. A new rule joins this list, or
 * the count below fails.
 */
const BRIDGE_PROBES = [
  "tailscale GET https://api.tailscale.com/api/v2/tailnet/-/devices",
  "bitwarden POST https://identity.bitwarden.com/connect/token",
  "bitwarden GET https://api.bitwarden.com/sync",
  "bitwarden POST https://identity.bitwarden.eu/connect/token",
  "bitwarden GET https://api.bitwarden.eu/sync",
  "bitwarden-sm POST https://identity.bitwarden.com/connect/token",
  "bitwarden-sm GET https://api.bitwarden.com/secrets/sync",
  "bitwarden-sm POST https://identity.bitwarden.eu/connect/token",
  "bitwarden-sm GET https://api.bitwarden.eu/secrets/sync",
];
/**
 * Higgsfield's key check: its preflight is answered HTTP 400 with no
 * Access-Control-Allow-Origin header, and its documentation says not to call
 * the API from browser code.
 */
const HIGGSFIELD_PROBE =
  "higgsfield GET https://api.higgsfield.ai/requests/00000000-0000-0000-0000-000000000000/status";
describe("audited browser-only policy", () => {
  it("compiles the single authored source without drift", () => {
    expect(JSON.parse(NATIVE_BROWSER_POLICY_JSON)).toEqual(authored);
    expect(NATIVE_BROWSER_POLICY_JSON).toBe(JSON.stringify(authored));
  });
  it("retains every policy decision field in the runtime projection", () => {
    expect(NATIVE_BROWSER_POLICY_RUNTIME_JSON).toBe(
      JSON.stringify(projectBrowserPolicy(authored)),
    );
    const runtime = JSON.parse(NATIVE_BROWSER_POLICY_RUNTIME_JSON);
    expect(NativeBrowserPolicySchema.parse(runtime)).toEqual(
      NativeBrowserPolicySchema.parse(authored),
    );
  });
  it("contains only TLS-verified concrete refusals with reproducible public evidence", () => {
    expect(authored.audited_origin).toBe("https://tyler-r-kendrick.github.io");
    const probes = authored.rules.map(
      (rule: { provider_id: string; probe: { method: string; url: string } }) =>
        `${rule.provider_id} ${rule.probe.method} ${rule.probe.url}`,
    );
    expect(probes).toEqual(
      expect.arrayContaining([...BRIDGE_PROBES, HIGGSFIELD_PROBE]),
    );
    // 94 rules were audited before the bridge; the rest are named above.
    expect(authored.rules).toHaveLength(94 + BRIDGE_PROBES.length + 1);
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
      const decision = nativeBrowserMethodPolicy(
        rule.provider_id,
        rule.method,
        rule.parameters,
      );
      if (rule.method === "api-key") {
        expect(decision).toMatchObject({
          available: true,
          reason: null,
          evidenceUrls: rule.evidence_urls,
        });
        expect(decision.advice).toContain(authored.checked_date);
        expect(decision.advice).toContain(authored.audited_origin);
        expect(decision.advice).toContain(
          "configured native Tailscale HTTP transport",
        );
        expect(decision.advice).toContain(
          "For direct browser requests, the endpoint must permit this site's origin and required headers.",
        );
      } else
        expect(decision).toMatchObject({
          available: false,
          reason: rule.reason,
          evidenceUrls: rule.evidence_urls,
        });
    }
  });
  it("retains parameter-specific historical advice without denying finite choices", () => {
    for (const id of ["datadog", "typeform", "railway"]) {
      const method = connectPlan(id)?.methods.find(
        (entry) => entry.kind === "api-key",
      );
      if (method?.kind !== "api-key" || !method.preset)
        throw new Error("Expected compiled API contract");
      const preset = method.preset;
      for (const variant of preset.credentialVariants)
        expect(
          nativeBrowserApiPolicy(id, { credential_variant: variant.id }).advice,
        ).toBeTruthy();
      for (const field of preset.templateParams)
        for (const choice of field.choices ?? [])
          expect(
            nativeBrowserApiPolicy(id, { [field.name]: choice.value }).advice,
          ).toBeTruthy();
      expect(nativeBrowserApiPolicy(id)).toMatchObject({
        available: true,
        reason: null,
      });
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
    // Global API observations remain advice; actual requests enforce browser access.
    expect(nativeBrowserApiPolicy("datadog").available).toBe(true);
    expect(nativeBrowserApiPolicy("datadog").advice).toBeTruthy();
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
