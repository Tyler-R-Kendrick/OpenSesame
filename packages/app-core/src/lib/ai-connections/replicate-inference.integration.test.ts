import { afterEach, expect, it, vi } from "vitest";
import { aiConnectionBinding, validateAiConnection } from "./configuration.js";
import { inferAiConnection } from "./inference.js";
import {
  aiConnectionDraft,
  aiConnectionFamilies,
  aiConnectionPreset,
  isAiConnectionProvider,
} from "./presets.js";
import {
  REPLICATE_TOKEN,
  replicateTlsFixture,
} from "./replicate-tls.test-support.js";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function setup(providerId = "byo-ai") {
  const f = await replicateTlsFixture(
    providerId === "byo-ai"
      ? "https://operator.example/custom/runtime"
      : "https://api.replicate.com/v1",
  );
  closes.push(f.close);
  return {
    ...f,
    draft: {
      ...aiConnectionDraft(providerId),
      family: "replicate_predictions" as const,
      baseUrl: f.baseUrl,
      model: "owner/model",
      apiKey: REPLICATE_TOKEN,
    },
  };
}
const input = {
  model: "owner/model",
  messages: [
    {
      role: "user" as const,
      content: JSON.stringify({
        prompt: "Actual operator prediction.",
        steps: 3,
      }),
    },
  ],
};
it.each(["byo-ai", "replicate"])(
  "uses real %s TLS create→processing→terminal and consumes exact result without following artifact/job URLs",
  async (provider) => {
    const f = await setup(provider);
    const ambient = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No ambient fallback"));
    const result = await inferAiConnection(f.draft, input, f.port, () => {});
    expect(JSON.parse(result.answer)).toEqual({
      text: "Independently produced prediction.",
      asset: "https://untrusted.example/generated.png",
    });
    expect(f.requests.map((row) => row.method)).toEqual(["POST", "GET", "GET"]);
    expect(JSON.parse(f.requests[0]?.body ?? "")).toEqual({
      input: { prompt: "Actual operator prediction.", steps: 3 },
    });
    expect(f.requests.every((row) => !row.path.includes("untrusted"))).toBe(
      true,
    );
    expect(ambient).not.toHaveBeenCalled();
  },
);
it.each(["failed", "empty", "wrong-id", "echo", "unauthorized", "forbidden"])(
  "never consumes %s as successful inference",
  async (mode) => {
    const f = await setup();
    f.state.mode = mode;
    f.state.pollsBeforeSuccess = 0;
    await expect(
      inferAiConnection(f.draft, input, f.port, () => {}),
    ).rejects.toThrow();
    expect(f.requests.length).toBeLessThanOrEqual(2);
  },
);
it("rejects malformed/nonobject or chat-shaped input before any create request", async () => {
  const f = await setup();
  for (const content of ["plain chat", "[]", "null", JSON.stringify("text")])
    await expect(
      inferAiConnection(
        f.draft,
        { ...input, messages: [{ role: "user", content }] },
        f.port,
        () => {},
      ),
    ).rejects.toThrow("JSON object");
  expect(f.requests).toHaveLength(0);
});
it("withdraws the captured owner while a real TLS poll body is held without a late result/request", async () => {
  const f = await setup();
  f.state.mode = "held";
  const text = vi.fn();
  const result = expect(
    inferAiConnection(f.draft, input, f.port, () => {}, text),
  ).rejects.toThrow();
  await f.held;
  expect(f.requests).toHaveLength(2);
  f.abort.abort();
  await result;
  await vi.waitFor(() =>
    expect(f.requests.at(-1)).toMatchObject({ closed: true, ended: false }),
  );
  expect(text).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(2);
});

it("derives the public native and BYO prediction configuration from the same validated preset", () => {
  const draft = {
    ...aiConnectionDraft("replicate"),
    model: "owner/model",
    apiKey: REPLICATE_TOKEN,
  };
  expect(validateAiConnection(draft).family).toBe("replicate_predictions");
  expect(aiConnectionPreset("replicate")).toMatchObject({
    family: "replicate_predictions",
  });
  expect(isAiConnectionProvider("replicate")).toBe(true);
  expect(aiConnectionFamilies("byo-ai").map((family) => family.id)).toContain(
    "replicate_predictions",
  );
});
it.each([
  { providerId: "openai" },
  { authentication: "none" },
  { model: "owner/../escape" },
  { model: "owner/model:latest" },
  { baseUrl: "https://operator.example/v1?credential=secret" },
  { baseUrl: "http://operator.example/v1" },
  { azure: { api: "v1", credential: "api-key" } },
  {
    vertex: {
      project: "project",
      location: "us-central1",
      credential: "access-token",
    },
  },
  { bedrock: { region: "us-east-1", credential: "sigv4" } },
])(
  "rejects invalid prediction target/authentication variants before dispatch %#",
  (change) => {
    expect(() =>
      validateAiConnection({
        ...aiConnectionDraft("replicate"),
        model: "owner/model",
        apiKey: REPLICATE_TOKEN,
        ...change,
      }),
    ).toThrow();
  },
);
it("binds the exact normalized endpoint, model and family without saving operation JSON", () => {
  const draft = validateAiConnection({
    ...aiConnectionDraft("replicate"),
    model: "owner/model",
    apiKey: REPLICATE_TOKEN,
  });
  const binding = aiConnectionBinding(draft);
  expect(binding).not.toContain(REPLICATE_TOKEN);
  expect(binding).not.toBe(
    aiConnectionBinding({ ...draft, model: "other/model" }),
  );
  expect(binding).not.toBe(
    aiConnectionBinding({ ...draft, baseUrl: "https://other.example/custom" }),
  );
  expect(() =>
    validateAiConnection({
      ...draft,
      predictionInput: { prompt: "must remain transient" },
    }),
  ).toThrow();
});
