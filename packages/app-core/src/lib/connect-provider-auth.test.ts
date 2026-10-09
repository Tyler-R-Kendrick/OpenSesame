import { describe, expect, it } from "vitest";
import {
  type ApiKeyPreset,
  connectPlan,
  connectPlans,
} from "./connect-plan.js";
import {
  ProviderAuthenticationSchema,
  ProviderCredentialFieldSchema,
  ProviderUrlSchema,
  ProviderVerificationSchema,
} from "./connect-provider-auth-schema.js";

function keyPreset(provider: string): ApiKeyPreset {
  const method = connectPlan(provider)?.methods.find(
    (item) => item.kind === "api-key",
  );
  if (method?.kind !== "api-key" || !method.preset)
    throw new Error(`API key preset missing: ${provider}`);
  return method.preset;
}

describe("generated provider authentication contracts", () => {
  it("retains provider-specific Bearer, raw custom header and Basic placement", () => {
    expect(keyPreset("openai").auth).toEqual({
      kind: "header",
      header: "Authorization",
      scheme: "Bearer",
      valueTemplate: null,
    });
    expect(keyPreset("anthropic").auth).toEqual({
      kind: "header",
      header: "x-api-key",
      scheme: null,
      valueTemplate: null,
    });
    expect(keyPreset("linear").auth).toEqual({
      kind: "header",
      header: "Authorization",
      scheme: null,
      valueTemplate: null,
    });
    expect(keyPreset("bamboohr").auth).toEqual({
      kind: "basic",
      username: "{key}",
      password: "x",
    });
    expect(keyPreset("mailgun").auth).toEqual({
      kind: "basic",
      username: "api",
      password: "{key}",
    });
  });

  it("preserves exact verification methods, headers, request bodies and account label paths", () => {
    expect(keyPreset("anthropic").verify).toMatchObject({
      method: "GET",
      url: "https://api.anthropic.com/v1/models",
      headers: { "anthropic-version": "2023-06-01" },
      accountField: null,
      body: null,
    });
    expect(keyPreset("notion").verify?.headers).toEqual({
      "Notion-Version": "2022-06-28",
    });
    expect(keyPreset("linear").verify).toMatchObject({
      method: "POST",
      url: "https://api.linear.app/graphql",
      accountField: "data.viewer.name",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(keyPreset("linear").verify?.body ?? "null")).toEqual({
      query: "{ viewer { id name email } }",
    });
    expect(keyPreset("algolia").verify?.headers).toEqual({
      "X-Algolia-Application-Id": "{application_id}",
    });
    expect(keyPreset("algolia").verify?.url).toBe(
      "https://{application_id}-dsn.algolia.net/1/indexes",
    );
  });

  it("retains explicit query and path auth without inferring them from a verification URL", () => {
    expect(keyPreset("similarweb").auth).toEqual({
      kind: "query",
      parameter: "api_key",
    });
    expect(keyPreset("telegram").auth).toEqual({
      kind: "path",
      template: "/bot{key}",
    });
  });

  it("retains compound header templates rather than inserting an invented separator", () => {
    expect(keyPreset("pagerduty").auth).toMatchObject({
      kind: "header",
      header: "Authorization",
      valueTemplate: "Token token={key}",
    });
  });

  it("retains provider success predicates so a successful HTTP status alone cannot activate invalid credentials", () => {
    expect(keyPreset("datadog").verify).toMatchObject({
      url: "https://api.{site}/api/v2/validate_keys",
      success: [{ field: "status", equals: "ok" }],
      headers: { "DD-APPLICATION-KEY": "{application_key}" },
    });
    expect(keyPreset("cloudflare").verify?.success).toContainEqual({
      field: "success",
      equals: true,
    });
    expect(keyPreset("sanity").verify?.requiredFields).toContain("id");
    expect(keyPreset("linear").verify?.errorFields).toContain("errors");
    expect(keyPreset("telegram").verify?.success).toEqual([
      { field: "ok", equals: true },
    ]);
  });

  it("preserves only the provider's permitted site choices and optional workspace classification", () => {
    const site = keyPreset("datadog").templateParams.find(
      (param) => param.name === "site",
    );
    expect(site?.choices).toHaveLength(9);
    expect(
      site?.choices?.some((choice) => choice.value === "datadoghq.eu"),
    ).toBe(true);
    expect(keyPreset("anthropic").templateParams).toContainEqual(
      expect.objectContaining({
        name: "workspace_id",
        required: false,
        secret: false,
      }),
    );
  });

  it("classifies additional credential slots as secret fields instead of public tenant parameters", () => {
    const marqeta = keyPreset("marqeta");
    expect(marqeta.basic?.password).toBe("{admin_access_token}");
    expect(marqeta.additionalCredentials).toContainEqual(
      expect.objectContaining({
        name: "admin_access_token",
        secret: true,
        required: true,
      }),
    );
    const datadog = keyPreset("datadog");
    expect(datadog.additionalCredentials).toContainEqual(
      expect.objectContaining({
        name: "application_key",
        secret: true,
        required: true,
      }),
    );
    expect(
      datadog.templateParams.some((param) => param.name === "application_key"),
    ).toBe(false);
    expect(
      ProviderCredentialFieldSchema.safeParse({
        name: "secret",
        label: "Secret",
        placeholder: "",
        required: true,
        secret: false,
      }).success,
    ).toBe(false);
  });

  it("preserves official Railway credential variants and their distinct verification requests", () => {
    const variants = keyPreset("railway").credentialVariants;
    expect(variants.map((variant) => variant.id)).toEqual([
      "account",
      "workspace",
      "project",
    ]);
    const account = variants.find((variant) => variant.id === "account");
    const workspace = variants.find((variant) => variant.id === "workspace");
    const project = variants.find((variant) => variant.id === "project");
    expect(account?.verify?.body).not.toBe(workspace?.verify?.body);
    expect(project?.auth).not.toEqual(account?.auth);
    expect(workspace?.templateParams).toContainEqual(
      expect.objectContaining({
        name: "workspace_id",
        required: true,
        secret: false,
      }),
    );
  });

  it("retains OAuth scope delimiters and custom API authorization placement", () => {
    const method = connectPlan("shopify")?.methods.find(
      (item) => item.kind === "oauth",
    );
    if (method?.kind !== "oauth" || !method.preset)
      throw new Error("Shopify OAuth preset missing");
    expect(method.preset.scopeSeparator).toBe(",");
    expect(method.preset.verify?.auth).toEqual({
      kind: "header",
      header: "X-Shopify-Access-Token",
      scheme: null,
      valueTemplate: null,
    });
  });

  it("retains actual MCP resource and registration authority instead of guessing from the server origin", () => {
    const method = connectPlan("adobe")?.methods.find(
      (item) => item.kind === "mcp",
    );
    if (method?.kind !== "mcp" || method.mcp.status !== "ok")
      throw new Error("Adobe MCP discovery missing");
    expect(method.mcp.resource).toBe(
      "https://express-mcp-service.adobe.io/mcp",
    );
    expect(method.mcp.registrationEndpoint).toBe(
      "https://express-mcp-service.adobe.io/register",
    );
    expect(method.mcp.tokenEndpoint).toBe(
      "https://ims-na1.adobelogin.com/ims/token/v3",
    );
    expect(method.mcp.tokenAuthMethods).toEqual(["none"]);
    expect(method.mcp.resourceMetadata).toContain(
      "/.well-known/oauth-protected-resource",
    );
  });

  it.each([
    "http://api.example.org/me",
    "https://user:password@api.example.org/me",
    "https://{unknown-value}/me",
    "javascript:alert(1)",
  ])("refuses invalid provider destination %s", (url) => {
    expect(ProviderUrlSchema.safeParse(url).success).toBe(false);
  });

  it("refuses credential-bearing metadata with header injection or a non-HTTPS verification destination", () => {
    expect(
      ProviderAuthenticationSchema.safeParse({
        kind: "header",
        header: "Authorization\r\nX-Other",
        scheme: "Bearer",
        valueTemplate: null,
      }).success,
    ).toBe(false);
    expect(
      ProviderVerificationSchema.safeParse({
        method: "GET",
        url: "http://api.example.org/me",
        accountField: null,
      }).success,
    ).toBe(false);
  });

  it("validates the whole emitted plan list and refuses entered values in credential field definitions", () => {
    const plans = connectPlans();
    expect(plans.length).toBeGreaterThan(170);
    expect(
      ProviderCredentialFieldSchema.safeParse({
        name: "key",
        label: "Key",
        placeholder: "",
        required: true,
        secret: true,
        value: "example-entered-provider-secret",
      }).success,
    ).toBe(false);
    expect(
      keyPreset("marqeta").additionalCredentials.every(
        (field) => field.secret === true,
      ),
    ).toBe(true);
  });
});
