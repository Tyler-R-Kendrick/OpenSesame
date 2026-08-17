import { describe, expect, it } from "vitest";
import type { Provider } from "./connections.js";
import {
  canConfigureAutomatically,
  configurationDefaults,
  configurationPayload,
  connectorSteps,
  connectorSummary,
  fieldGuidance,
  needsScopeSelection,
} from "./connector-guidance.js";

const provider = (overrides: Partial<Provider> = {}): Provider => ({
  id: "age",
  displayName: "age",
  category: "encryption",
  docsUrl: "https://fnox.jdx.dev/providers/age.html",
  authKind: "configuration",
  supportsRefresh: false,
  configured: true,
  autoConfigurable: false,
  missingConfig: [],
  scopes: [],
  egress: { scheme: "none", authorities: [], pathPrefixes: [] },
  operations: [],
  configurationFields: [],
  ...overrides,
  callbackUrl: overrides.callbackUrl ?? null,
});

describe("connector setup guidance", () => {
  it("explains purpose and the shortest setup path", () => {
    expect(connectorSummary(provider())).toContain("Encrypt secrets");
    expect(connectorSteps(provider())).toHaveLength(3);
  });

  it("adapts the steps to OAuth and API keys", () => {
    expect(
      connectorSteps(provider({ authKind: "oauth2_authorization_code" })).join(
        " ",
      ),
    ).toContain("consent window");
    expect(
      connectorSteps(provider({ authKind: "api_key" })).join(" "),
    ).toContain("least-privilege API key");
  });

  it("provides visible field help and safe examples", () => {
    expect(
      fieldGuidance({
        name: "recipients",
        label: "Recipients",
        secret: false,
        required: true,
      }).placeholder,
    ).toContain("age1");
    expect(
      fieldGuidance({
        name: "custom_secret",
        label: "Custom secret",
        secret: true,
        required: true,
      }).placeholder,
    ).toContain("Paste");
  });

  it("never describes required fields as optional", () => {
    for (const name of ["session_token", "namespace"]) {
      const guidance = fieldGuidance({
        name,
        label: name,
        secret: name === "session_token",
        required: true,
      });
      expect(`${guidance.help} ${guidance.placeholder}`).not.toMatch(
        /optional|leave blank/i,
      );
    }
  });

  it("fills only stable local defaults", () => {
    expect(configurationDefaults(provider({ id: "keychain" }))).toEqual({
      service: "opensesame",
    });
    expect(configurationDefaults(provider({ id: "plain" }))).toEqual({
      namespace: "opensesame",
    });
    expect(configurationDefaults(provider({ id: "aws-kms" }))).toEqual({});
    expect(configurationDefaults(provider({ id: "better-auth" }))).toEqual({
      api_key_header: "x-api-key",
      config_id: "default",
    });
  });

  it("identifies providers the Host can configure without user input", () => {
    expect(
      canConfigureAutomatically(provider({ autoConfigurable: true })),
    ).toBe(true);
    expect(canConfigureAutomatically(provider())).toBe(false);
  });

  it("derives the Auth0 Management API audience from its tenant domain", () => {
    expect(
      configurationPayload(provider({ id: "auth0" }), {
        domain: "https://tenant.us.auth0.com/",
        client_id: " client ",
        client_secret: " secret ",
        audience: "",
      }),
    ).toEqual({
      domain: "tenant.us.auth0.com",
      client_id: "client",
      client_secret: "secret",
      audience: "https://tenant.us.auth0.com/api/v2/",
    });
  });

  it("explains delegated Host credentials before manual overrides", () => {
    expect(connectorSteps(provider({ id: "aws-kms" })).join(" ")).toContain(
      "workload identity",
    );
    expect(
      fieldGuidance({
        name: "access_key_id",
        label: "Access key ID",
        secret: false,
        required: false,
      }).help,
    ).toContain("default credential chain");
  });

  it("allows providers whose protocol has no scope vocabulary", () => {
    expect(needsScopeSelection(provider({ scopes: [] }), [])).toBe(false);
    expect(
      needsScopeSelection(
        provider({
          scopes: [
            {
              name: "read",
              description: "Read data",
              sensitive: false,
              default: false,
            },
          ],
        }),
        [],
      ),
    ).toBe(true);
  });
});
