import type { BoundaryObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { aiConnectionBinding, validateAiConnection } from "./configuration.js";
import { aiConnectionDraft, aiConnectionPreset } from "./presets.js";

const draft = () => ({
  ...aiConnectionDraft("byo-ai"),
  baseUrl: "https://models.example/mount/v1",
  model: "model-v1",
  apiKey: "secret-key",
});

const azure = () => ({
  ...draft(),
  model: "deployment-01",
  azure: { api: "v1", credential: "api-key" } as const,
});
describe("Azure public target configuration and credential binding", () => {
  it("preserves literal legacy binding bytes and omits Azure from generic drafts", () => {
    const validated = validateAiConnection(draft());
    expect(validated).not.toHaveProperty("azure");
    expect(aiConnectionBinding(validated)).toBe(
      '["byo-ai","openai_chat","https://models.example/mount/v1","model-v1","api-key","max_completion_tokens"]',
    );
  });
  it("binds the exact canonical Azure suffix independently of object property order", () => {
    const validated = validateAiConnection(azure());
    const binding = aiConnectionBinding(validated);
    expect(binding).toBe(
      '["byo-ai","openai_chat","https://models.example/mount/v1","deployment-01","api-key","max_completion_tokens",["azure-openai","v1",null,"api-key"]]',
    );
    expect(
      aiConnectionBinding({
        ...validated,
        azure: { credential: "api-key", api: "v1" },
      }),
    ).toBe(binding);
    const targets = [
      { api: "v1", credential: "entra-token" },
      { api: "dated-chat", apiVersion: "2024-06-01", credential: "api-key" },
      { api: "dated-chat", apiVersion: "2024-10-21", credential: "api-key" },
    ] as const;
    const distinct = targets.map((target) =>
      aiConnectionBinding(validateAiConnection({ ...azure(), azure: target })),
    );
    expect(new Set([binding, ...distinct]).size).toBe(4);
    expect(distinct[1]).toBe(
      '["byo-ai","openai_chat","https://models.example/mount/v1","deployment-01","api-key","max_completion_tokens",["azure-openai","dated-chat","2024-06-01","api-key"]]',
    );
  });
  it.each(["api-key", "entra-token"] as const)(
    "validates a blank public %s field without resolving its credential",
    (credential) => {
      const value = {
        ...azure(),
        apiKey: "",
        azure: { api: "v1", credential },
      };
      expect(validateAiConnection(value, false).apiKey).toBe("");
      expect(() => validateAiConnection(value)).toThrow(/Enter an API key/);
    },
  );
  const invalid: [string, BoundaryObject][] = [
    ["foreign OpenAI partner", { providerId: "openai" }],
    ["foreign Anthropic partner", { providerId: "anthropic" }],
    ["foreign Gemini partner", { providerId: "gemini" }],
    ["foreign protocol", { family: "anthropic_messages" }],
    ["no authentication", { authentication: "none" }],
    ["deployment route", { model: "deployment/other" }],
    [
      "extra target key",
      { azure: { api: "v1", credential: "api-key", token: "secret-key" } },
    ],
    ["missing credential kind", { azure: { api: "v1" } }],
    [
      "missing dated version",
      { azure: { api: "dated-chat", credential: "api-key" } },
    ],
    [
      "v1 dated version",
      { azure: { api: "v1", apiVersion: "2024-06-01", credential: "api-key" } },
    ],
    [
      "dated Responses",
      {
        family: "openai_responses",
        azure: {
          api: "dated-chat",
          apiVersion: "2024-06-01",
          credential: "api-key",
        },
      },
    ],
    ["secret name", { name: "secret-key" }],
    ["secret endpoint", { baseUrl: "https://models.example/secret-key" }],
    ["secret deployment", { model: "secret-key" }],
    [
      "secret target version",
      {
        azure: {
          api: "dated-chat",
          apiVersion: "secret-key",
          credential: "api-key",
        },
      },
    ],
  ];
  it.each(invalid)(
    "refuses %s without echoing private input",
    (_name, patch) => {
      const value = { ...azure(), ...patch };
      expect(() => validateAiConnection(value)).toThrow();
      try {
        validateAiConnection(value);
      } catch (error) {
        expect(String(error)).not.toContain("secret-key");
      }
    },
  );
});
describe("common AI configuration", () => {
  it.each([
    "https://secret:password@models.example/v1",
    "https://models.example/v1?key=secret",
    "https://models.example/v1#secret",
    "http://models.example/v1",
    "https://models.example/%2e%2e/other",
    "https://models.example/v1\\other",
  ])("refuses unsafe endpoint %s", (baseUrl) => {
    expect(() => validateAiConnection({ ...draft(), baseUrl })).toThrow();
  });
  it("derives partner families and endpoints from the existing catalog", () => {
    expect(aiConnectionPreset("anthropic")).toMatchObject({
      family: "anthropic_messages",
      baseUrl: "https://api.anthropic.com/v1",
    });
    expect(aiConnectionPreset("gemini")).toMatchObject({
      family: "gemini_generate_content",
    });
    expect(aiConnectionPreset("groq")).toMatchObject({
      family: "openai_chat",
      baseUrl: "https://api.groq.com/openai/v1",
    });
    expect(aiConnectionPreset("replicate")).toMatchObject({
      family: "replicate_predictions",
      baseUrl: "https://api.replicate.com/v1",
    });
    expect(() =>
      validateAiConnection({
        ...draft(),
        providerId: "anthropic",
        family: "openai_chat",
      }),
    ).toThrow(/protocol supported/);
  });
  it("does not let a Gemini model become a route or public fields disclose the API key", () => {
    expect(() =>
      validateAiConnection({
        ...draft(),
        family: "gemini_generate_content",
        model: "../other",
      }),
    ).toThrow();
    expect(() =>
      validateAiConnection({ ...draft(), name: "secret-key" }),
    ).toThrow(/public connection/);
  });
});
