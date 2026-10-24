import { afterEach, expect, it, vi } from "vitest";
import {
  BEDROCK_CREDENTIAL,
  bedrockFixture,
} from "./bedrock-http.test-support.js";
import { inferBedrockAi } from "./bedrock-inference.js";
import {
  type BedrockAiDraft,
  BedrockAiTargetSchema,
} from "./bedrock-target.js";
import { aiConnectionDraft } from "./presets.js";
import {
  aiConnectionHeaders,
  aiInferenceAnswer,
  aiInferenceRequest,
} from "./protocol.js";
import { readAiTextStream } from "./stream.js";
import type { AiConnectionDraft } from "./types.js";
afterEach(() => vi.restoreAllMocks());
function draft(): BedrockAiDraft {
  return {
    providerId: "aws-bedrock",
    name: "Bedrock",
    family: "bedrock_converse",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/",
    model: "anthropic.claude-3-haiku-20240307-v1:0",
    authentication: "api-key",
    apiKey: JSON.stringify(BEDROCK_CREDENTIAL),
    tokenParameter: "max_tokens",
    bedrock: { region: "us-east-1", credential: "sigv4" },
  };
}
const input = {
  model: "anthropic.claude-3-haiku-20240307-v1:0",
  messages: [
    { role: "system" as const, content: "Stay concise." },
    { role: "user" as const, content: "Actual question." },
  ],
  maxOutputTokens: 32,
};
it.each([
  { providerId: "aws-bedrock", tls: false, withSession: true },
  { providerId: "byo-ai", tls: false, withSession: true },
  { providerId: "aws-bedrock", tls: true, withSession: true },
  { providerId: "aws-bedrock", tls: true, withSession: false },
])(
  "executes genuine $providerId Converse and independently verified SigV4 (TLS=$tls, session=$withSession)",
  async ({ providerId, tls, withSession }) => {
    const fixture = await bedrockFixture(withSession, tls);
    const onText = vi.fn();
    try {
      const configured = { ...draft(), providerId };
      const { sessionToken, ...longTerm } = BEDROCK_CREDENTIAL;
      if (!withSession) configured.apiKey = JSON.stringify(longTerm);
      if (tls) configured.model = "amazon.nova-lite-v1:0";
      const selectedInput = tls
        ? {
            ...input,
            model: configured.model,
            messages: [
              { role: "system" as const, content: "Keep it short." },
              { role: "user" as const, content: "Real signed TLS question." },
            ],
            maxOutputTokens: 17,
          }
        : input;
      const ambient = tls
        ? vi
            .spyOn(globalThis, "fetch")
            .mockRejectedValue(new Error("No ambient transport"))
        : null;
      expect(fixture.origin.startsWith("https:")).toBe(tls);
      if (providerId === "byo-ai")
        configured.baseUrl = "http://localhost:41999/custom/bedrock";
      await expect(
        inferBedrockAi(
          configured,
          selectedInput,
          fixture.port,
          fixture.port.assertCurrent,
          onText,
        ),
      ).resolves.toEqual({
        providerId,
        model: selectedInput.model,
        answer: "Exact Bedrock answer.",
      });
      if (ambient) expect(ambient).not.toHaveBeenCalled();
      expect(fixture.records).toHaveLength(1);
      const call = fixture.records[0];
      expect(call).toMatchObject({ authenticated: true, ended: true });
      expect(call?.path).toBe(
        `${providerId === "byo-ai" ? "/custom/bedrock" : ""}/model/${encodeURIComponent(configured.model)}/converse`,
      );
      expect(JSON.parse(call?.body ?? "null")).toEqual({
        messages: [
          {
            role: "user",
            content: [{ text: selectedInput.messages[1].content }],
          },
        ],
        system: [{ text: selectedInput.messages[0].content }],
        inferenceConfig: { maxTokens: selectedInput.maxOutputTokens },
      });
      expect(call?.body).not.toContain(BEDROCK_CREDENTIAL.secretAccessKey);
      expect(onText).toHaveBeenCalledExactlyOnceWith("Exact Bedrock answer.");
    } finally {
      await fixture.close();
    }
  },
);
it.each(["unauthorized", "malformed", "echo", "tool-use"])(
  "rejects actual %s response without a published answer",
  async (mode) => {
    const fixture = await bedrockFixture();
    const onText = vi.fn();
    try {
      fixture.setMode(mode);
      await expect(
        inferBedrockAi(
          draft(),
          input,
          fixture.port,
          fixture.port.assertCurrent,
          onText,
        ),
      ).rejects.toThrow();
      expect(onText).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  },
);
it.each([false, true])(
  "physically aborts a held actual response on original owner withdrawal (TLS=%s)",
  async (tls) => {
    const fixture = await bedrockFixture(true, tls);
    const onText = vi.fn();
    try {
      fixture.setMode("held");
      const running = inferBedrockAi(
        draft(),
        input,
        fixture.port,
        fixture.port.assertCurrent,
        onText,
      );
      const refused = expect(running).rejects.toThrow();
      await expect.poll(() => fixture.records.length).toBe(1);
      expect(fixture.records[0]?.ended).toBe(false);
      fixture.abort.abort();
      await refused;
      await expect.poll(() => fixture.records[0]?.closed).toBe(true);
      expect(fixture.records[0]?.ended).toBe(false);
      expect(onText).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  },
);
it("fails before egress for invalid public target, credential, conversation and model binding", async () => {
  const fixture = await bedrockFixture();
  try {
    expect(
      BedrockAiTargetSchema.safeParse({
        ...draft().bedrock,
        secretAccessKey: BEDROCK_CREDENTIAL.secretAccessKey,
      }).success,
    ).toBe(false);
    for (const change of [
      { providerId: "openai" },
      { baseUrl: "https://evil.example/" },
      { model: "../other" },
      {
        bedrock: { region: "us-east-1", credential: "sigv4" as const },
        apiKey: "{}",
      },
    ])
      await expect(
        inferBedrockAi(
          { ...draft(), ...change },
          input,
          fixture.port,
          fixture.port.assertCurrent,
        ),
      ).rejects.toThrow();
    await expect(
      inferBedrockAi(
        draft(),
        {
          ...input,
          messages: [{ role: "system", content: "Only a system message." }],
        },
        fixture.port,
        fixture.port.assertCurrent,
      ),
    ).rejects.toThrow();
    expect(fixture.records).toEqual([]);
  } finally {
    await fixture.close();
  }
});
it("does not adopt a later owner when one captured request is held and another completes", async () => {
  const a = await bedrockFixture();
  const b = await bedrockFixture();
  const late = vi.fn();
  try {
    a.setMode("held");
    const running = inferBedrockAi(
      draft(),
      input,
      a.port,
      a.port.assertCurrent,
      late,
    );
    const rejected = expect(running).rejects.toThrow();
    await expect.poll(() => a.records.length).toBe(1);
    await expect(
      inferBedrockAi(draft(), input, b.port, b.port.assertCurrent),
    ).resolves.toMatchObject({ answer: "Exact Bedrock answer." });
    a.abort.abort();
    await rejected;
    await expect.poll(() => a.records[0]?.closed).toBe(true);
    expect(b.records[0]).toMatchObject({ authenticated: true, ended: true });
    expect(late).not.toHaveBeenCalled();
  } finally {
    await a.close();
    await b.close();
  }
});

it.each(["secretAccessKey", "sessionToken"] as const)(
  "rejects a wrong actual %s at the independent AWS verifier",
  async (field) => {
    const fixture = await bedrockFixture(true, true);
    const onText = vi.fn();
    try {
      const configured = draft();
      configured.apiKey = JSON.stringify({
        ...BEDROCK_CREDENTIAL,
        [field]: "wrongCredentialMaterial0123456789",
      });
      const rejected = inferBedrockAi(
        configured,
        input,
        fixture.port,
        fixture.port.assertCurrent,
        onText,
      );
      await expect(rejected).rejects.toThrow();
      await expect(rejected).rejects.toMatchObject({ code: "authentication" });
      expect(fixture.records).toHaveLength(1);
      expect(fixture.records[0]).toMatchObject({
        authenticated: false,
        ended: true,
      });
      expect(onText).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  },
);
it("does not expose malformed credential source through its validation error", async () => {
  const fixture = await bedrockFixture();
  try {
    const configured = draft();
    configured.apiKey = "not JSON secret=privateCredentialMaterial";
    await expect(
      inferBedrockAi(
        configured,
        input,
        fixture.port,
        fixture.port.assertCurrent,
      ),
    ).rejects.toThrow("Enter valid AWS credential JSON.");
    expect(fixture.records).toEqual([]);
  } finally {
    await fixture.close();
  }
});

it("supports a long-term AWS key without an invented session token", async () => {
  const fixture = await bedrockFixture(false);
  try {
    const configured = draft();
    configured.apiKey = JSON.stringify({
      accessKeyId: BEDROCK_CREDENTIAL.accessKeyId,
      secretAccessKey: BEDROCK_CREDENTIAL.secretAccessKey,
    });
    await expect(
      inferBedrockAi(
        configured,
        input,
        fixture.port,
        fixture.port.assertCurrent,
      ),
    ).resolves.toMatchObject({ answer: "Exact Bedrock answer." });
    expect(fixture.records[0]).toMatchObject({
      authenticated: true,
      ended: true,
    });
  } finally {
    await fixture.close();
  }
});

it("rejects an ambiguous target and dot-segment model before egress", async () => {
  const fixture = await bedrockFixture();
  try {
    const ambiguous = draft();
    ambiguous.vertex = {
      project: "my-project-123",
      location: "us-central1",
      credential: "access-token",
    };
    await expect(
      inferBedrockAi(
        ambiguous,
        input,
        fixture.port,
        fixture.port.assertCurrent,
      ),
    ).rejects.toThrow();
    const dotModel = { ...draft(), model: ".." };
    await expect(
      inferBedrockAi(
        dotModel,
        { ...input, model: ".." },
        fixture.port,
        fixture.port.assertCurrent,
      ),
    ).rejects.toThrow();
    expect(fixture.records).toEqual([]);
  } finally {
    await fixture.close();
  }
});

it("refuses Bedrock in every generic API-key/request/answer/SSE boundary", async () => {
  const draft: AiConnectionDraft = {
    ...aiConnectionDraft("byo-ai"),
    family: "bedrock_converse",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    model: "amazon.nova-lite-v1:0",
    apiKey: "must-not-be-a-bearer",
  };
  const input = {
    model: draft.model,
    messages: [{ role: "user" as const, content: "question" }],
  };
  expect(() => aiConnectionHeaders(draft)).toThrow("signed");
  expect(() => aiInferenceRequest(draft, input)).toThrow("signed");
  expect(() => aiInferenceAnswer(draft.family, {})).toThrow("finite");
  const response = Response.json({});
  await expect(
    readAiTextStream(
      response,
      draft.family,
      () => {},
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("finite");
  expect(response.body?.locked).toBe(false);
  await response.body?.cancel();
});
