import { describe, expect, it, vi } from "vitest";
import { aiConnectionBase as sharedBase } from "./base-url.js";
import {
  aiConnectionBase,
  aiConnectionBinding,
  validateAiConnection,
} from "./configuration.js";
import { aiConnectionFamilies, aiConnectionPreset } from "./presets.js";
import {
  aiConnectionHeaders,
  aiInferenceAnswer,
  aiInferenceRequest,
} from "./protocol.js";
import {
  STABILITY_SD3_BASE,
  STABILITY_SD3_MODEL,
  validateAiStabilityConnection,
  validateStabilityTarget,
} from "./stability-target.js";
import { readAiTextStream } from "./stream.js";
import { isAiImageFamily, textAiFamily } from "./types.js";

function draft(providerId: "stability" | "byo-ai" = "stability") {
  return {
    providerId,
    name: "Explicit SD3 configuration",
    family: "stability_sd3" as const,
    baseUrl:
      providerId === "stability"
        ? STABILITY_SD3_BASE
        : "https://operator.example/custom/images",
    model: STABILITY_SD3_MODEL,
    authentication: "api-key" as const,
    apiKey: "owned-image-key",
    tokenParameter: "max_tokens" as const,
  };
}
describe("strict Stability family configuration and native/BYO activation", () => {
  it.each(["sd3.5-medium", "sd3.5-large", "sd3.5-large-turbo"])(
    "accepts official native model %s with the exact existing kernel base",
    (model) => {
      const value = validateAiConnection({ ...draft(), model });
      expect(value).toMatchObject({
        providerId: "stability",
        family: "stability_sd3",
        model,
        baseUrl: "https://api.stability.ai/v2beta/stable-image",
        authentication: "api-key",
      });
      expect(validateAiStabilityConnection(value).model).toBe(model);
    },
  );
  it("retains BYO mount and exact model and binds family/endpoint/model/authentication deterministically", () => {
    const value = validateAiConnection({
      ...draft("byo-ai"),
      model: "operator-image-model",
      baseUrl: "https://operator.example/custom/images/",
    });
    expect(value.baseUrl).toBe("https://operator.example/custom/images");
    expect(aiConnectionBinding(value)).toBe(
      '["byo-ai","stability_sd3","https://operator.example/custom/images","operator-image-model","api-key","max_tokens"]',
    );
    expect(aiConnectionBinding({ ...value, model: "replacement" })).not.toBe(
      aiConnectionBinding(value),
    );
    expect(aiConnectionBinding({ ...value, family: "openai_chat" })).not.toBe(
      aiConnectionBinding(value),
    );
  });
  it.each(["stability", "byo-ai"] as const)(
    "validates public %s configuration without a key placeholder, while operation validation still requires the real key",
    (providerId) => {
      const value = { ...draft(providerId), apiKey: "" };
      expect(validateAiConnection(value, false).apiKey).toBe("");
      expect(validateAiStabilityConnection(value, false).apiKey).toBe("");
      expect(() => validateAiConnection(value)).toThrow();
      expect(() => validateAiStabilityConnection(value)).toThrow();
    },
  );
  const invalid = [
    ["foreign native model", { model: "sd3.5-flash" }],
    ["legacy native v1 endpoint", { baseUrl: "https://api.stability.ai/v1" }],
    [
      "foreign native host",
      { baseUrl: "https://elsewhere.example/v2beta/stable-image" },
    ],
    [
      "wrong native endpoint",
      { baseUrl: `${STABILITY_SD3_BASE}/generate/sd3` },
    ],
    ["foreign provider", { providerId: "openai" }],
    ["native text family", { family: "openai_chat" }],
    ["native transcription family", { family: "elevenlabs_scribe" }],
    ["anonymous credential", { authentication: "none" }],
    ["Azure credentials", { azure: { api: "v1", credential: "api-key" } }],
    [
      "Vertex credentials",
      {
        vertex: {
          project: "owned-project",
          location: "global",
          credential: "service-account",
        },
      },
    ],
    [
      "Bedrock credentials",
      { bedrock: { region: "us-east-1", credential: "sigv4" } },
    ],
    ["extra secret field", { accessToken: "private-material" }],
    ["secret name", { name: "owned-image-key" }],
    ["secret model", { model: "owned-image-key" }],
    ["whitespace key", { apiKey: "key with spaces" }],
    ["control key", { apiKey: "key\r\nsecret" }],
  ] as const;
  it.each(invalid)(
    "refuses %s before request construction without reflecting supplied credentials",
    (_name, patch) => {
      const supplied = { ...draft(), ...patch };
      expect(() => validateAiConnection(supplied)).toThrow();
      try {
        validateAiConnection(supplied);
      } catch (error) {
        expect(String(error)).not.toContain(supplied.apiKey);
        expect(String(error)).not.toContain("private-material");
      }
    },
  );
  it.each([
    "https://user:password@operator.example/images",
    "https://operator.example/images?key=private",
    "https://operator.example/images#private",
    "http://operator.example/images",
    "https://operator.example/%2e%2e/secret",
    "https://operator.example/%2fsecret",
    "https://operator.example/%5csecret",
    "https://operator.example/images\\other",
  ])("preserves existing unsafe BYO URL rejection: %s", (baseUrl) => {
    expect(() =>
      validateAiConnection({ ...draft("byo-ai"), baseUrl }),
    ).toThrow();
  });
  it("retains legacy shared URL normalization and exposes the exact native/BYO image protocol", () => {
    expect(aiConnectionBase).toBe(sharedBase);
    expect(aiConnectionBase(" https://models.example/mount/// ").href).toBe(
      "https://models.example/mount/",
    );
    expect(aiConnectionBase("http://127.0.0.1:8080/mount").href).toBe(
      "http://127.0.0.1:8080/mount/",
    );
    expect(aiConnectionPreset("stability")).toMatchObject({
      family: "stability_sd3",
      baseUrl: STABILITY_SD3_BASE,
      model: STABILITY_SD3_MODEL,
    });
    expect(
      aiConnectionFamilies("byo-ai").some(
        (item) => String(item.id) === "stability_sd3",
      ),
    ).toBe(true);
    expect(isAiImageFamily("stability_sd3")).toBe(true);
    expect(isAiImageFamily("openai_chat")).toBe(false);
  });
  it("does not relax direct strict target validation when no key is supplied", () => {
    const value = validateAiStabilityConnection(draft());
    expect(() => validateStabilityTarget({ ...value, apiKey: "" })).toThrow();
    expect(
      validateStabilityTarget({ ...value, apiKey: "" }, false).apiKey,
    ).toBe("");
  });
});
describe("image family cannot borrow text framing or credential builders", () => {
  it("rejects generic text builders, headers and answer parsers before reading image content", () => {
    const value = validateAiConnection(draft());
    const input = {
      model: value.model,
      messages: [{ role: "user" as const, content: "A lighthouse" }],
    };
    expect(() => textAiFamily(value.family)).toThrow();
    expect(() => aiInferenceRequest(value, input)).toThrow();
    expect(() => aiInferenceRequest(value, input, true)).toThrow();
    expect(() => aiConnectionHeaders(value)).toThrow();
    expect(() =>
      aiInferenceAnswer(value.family, {
        image: "not-a-text-answer",
        finish_reason: "SUCCESS",
      }),
    ).toThrow();
  });
  it("rejects text streaming before acquiring or reading its response body", async () => {
    const pulled = vi.fn();
    const cancelled = vi.fn();
    const onText = vi.fn();
    const check = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      { pull: pulled, cancel: cancelled },
      { highWaterMark: 0 },
    );
    const response = new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
    const getReader = vi.spyOn(body, "getReader");
    const clone = vi.spyOn(response, "clone");
    await expect(
      readAiTextStream(
        response,
        "stability_sd3",
        onText,
        check,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(pulled).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(getReader).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
    await response.body?.cancel();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
