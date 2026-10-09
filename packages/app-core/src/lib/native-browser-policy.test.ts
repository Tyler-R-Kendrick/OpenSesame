import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connectPlan } from "./connect-plan.js";
import { NATIVE_BROWSER_POLICY_JSON } from "./native-browser-policy.generated.js";
import {
  nativeBrowserApiPolicy,
  nativeBrowserMethodPolicy,
  nativeBrowserOAuthPolicy,
} from "./native-browser-policy.js";

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
    expect(authored.rules).toHaveLength(39);
    for (const rule of authored.rules) {
      expect(rule.probe.tls_verified).toBe(true);
      expect(rule.probe.status).toBeLessThan(500);
      expect(rule.probe.url).not.toMatch(/[{}]/);
      expect(rule.probe.allow_origin).not.toBe("*");
      expect(rule.probe.allow_origin).not.toBe(authored.audited_origin);
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
    expect(nativeBrowserMethodPolicy("resend", "mcp").available).toBe(true);
    expect(
      nativeBrowserApiPolicy("datadog", { site: "unknown.example" }).available,
    ).toBe(true);
  });
});
