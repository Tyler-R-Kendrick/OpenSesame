import { expect, it } from "vitest";
import { gcpKeyFile, installGcpKey } from "../native-gcp.test-support.js";
import { aiConnectionBinding, validateAiConnection } from "./configuration.js";
import {
  aiConnectionDraft,
  aiConnectionFamilies,
  isAiConnectionProvider,
} from "./presets.js";
import { TOKEN } from "./vertex-http.test-support.js";
import type { VertexAiDraft } from "./vertex-target.js";
installGcpKey();
function configured(): VertexAiDraft {
  return {
    ...aiConnectionDraft("google-vertex"),
    model: "gemini-2.5-flash",
    apiKey: gcpKeyFile(),
    vertex: {
      project: "my-project-123",
      location: "us-central1",
      credential: "service-account",
    },
  };
}

it("uses the existing Gemini family and strictly normalizes only the private service-account document", () => {
  const value = validateAiConnection(configured());
  expect(value.family).toBe("gemini_generate_content");
  expect(isAiConnectionProvider("google-vertex")).toBe(false);
  expect(isAiConnectionProvider("byo-ai")).toBe(true);
  expect(aiConnectionFamilies("google-vertex").map((item) => item.id)).toEqual([
    "gemini_generate_content",
  ]);
  const account = JSON.parse(value.apiKey);
  expect(account.type).toBe("service_account");
  expect(account.token_uri).toBeUndefined();
  expect(account.private_key).toContain("BEGIN PRIVATE KEY");
  expect(validateAiConnection({ ...value, apiKey: "" }, false).vertex).toEqual(
    value.vertex,
  );
  expect(() => validateAiConnection({ ...value, apiKey: "" })).toThrow();
});
it("binds project/location/mode/model/endpoint while preserving original non-Vertex bytes", () => {
  const original = configured();
  const bound = aiConnectionBinding(original);
  for (const change of [
    { vertex: { ...original.vertex, project: "other-project-123" } },
    { vertex: { ...original.vertex, location: "europe-west4" } },
    { vertex: { ...original.vertex, credential: "access-token" as const } },
    { model: "gemini-2.0-flash" },
    { baseUrl: "https://other.example/v1" },
  ])
    expect(aiConnectionBinding({ ...original, ...change })).not.toBe(bound);
  for (const provider of ["openai", "byo-ai", "gemini", "anthropic"]) {
    const draft = {
      ...aiConnectionDraft(provider),
      baseUrl: "https://models.example/v1",
      model: "model",
    };
    expect(aiConnectionBinding(draft)).toBe(
      JSON.stringify([
        draft.providerId,
        draft.family,
        draft.baseUrl,
        draft.model,
        draft.authentication,
        draft.tokenParameter,
      ]),
    );
  }
  const azure = {
    ...aiConnectionDraft("azure-openai"),
    baseUrl: "https://resource.openai.azure.com",
    model: "deployment",
  };
  expect(aiConnectionBinding(azure)).toBe(
    JSON.stringify([
      azure.providerId,
      azure.family,
      azure.baseUrl,
      azure.model,
      azure.authentication,
      azure.tokenParameter,
      ["azure-openai", "v1", null, "api-key"],
    ]),
  );
});
it("uses same strict target in BYO without mistaking supplied Bearer token for a Gemini API key", () => {
  const draft = configured();
  draft.providerId = "byo-ai";
  draft.baseUrl = "http://localhost:41999/custom";
  draft.vertex = { ...draft.vertex, credential: "access-token" };
  draft.apiKey = TOKEN;
  expect(validateAiConnection(draft).vertex).toEqual(draft.vertex);
});
it("rejects hidden secrets, unsupported cross-provider metadata and simultaneous Azure/Vertex", () => {
  const draft = configured();
  for (const value of [
    { ...draft, vertex: { ...draft.vertex, access_token: TOKEN } },
    { ...draft, providerId: "openai" },
    { ...draft, family: "openai_chat" },
    { ...draft, azure: { api: "v1", credential: "api-key" } },
    { ...draft, baseUrl: "https://wrong.example/v1" },
    { ...draft, vertex: { ...draft.vertex, location: "../global" } },
  ])
    expect(() => validateAiConnection(value)).toThrow();
  expect(() =>
    validateAiConnection({
      ...draft,
      name: JSON.parse(draft.apiKey).private_key,
    }),
  ).toThrow();
});
