import type { ServerResponse } from "node:http";
import type { BoundaryObject } from "@opensesame/os-domain";
import { afterEach, expect, it } from "vitest";
import { inferAiConnection } from "./inference.js";
import { aiConnectionDraft } from "./presets.js";
import {
  type CapturedAiRequest,
  aiHttpFixture,
} from "./protocol.test-support.js";
import {
  type AiConnectionDraft,
  AiConnectionError,
  type AiConnectionTransport,
} from "./types.js";

const key = "private-azure-credential";
const deployment = "deployment.prod-01";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});
const contracts = [
  { api: "v1", family: "openai_chat" },
  { api: "v1", family: "openai_responses" },
  { api: "dated-chat", family: "openai_chat" },
] as const;
const cases = contracts.flatMap((contract) =>
  ["azure-openai", "byo-ai"].flatMap((providerId) =>
    (["api-key", "entra-token"] as const).map((credential) => ({
      ...contract,
      providerId,
      credential,
    })),
  ),
);
type Contract = (typeof cases)[number];
function draftAt(
  baseUrl: string,
  entry: Contract = cases[0],
): AiConnectionDraft {
  return {
    ...aiConnectionDraft("byo-ai"),
    providerId: entry.providerId,
    baseUrl,
    model: deployment,
    apiKey: key,
    family: entry.family,
    azure:
      entry.api === "dated-chat"
        ? {
            api: entry.api,
            apiVersion: "2024-06-01",
            credential: entry.credential,
          }
        : { api: entry.api, credential: entry.credential },
  };
}
function infer(
  draft: AiConnectionDraft,
  transport: AiConnectionTransport,
  onText?: (text: string) => void,
) {
  return inferAiConnection(
    draft,
    {
      model: draft.model,
      messages: [{ role: "user", content: "Hello" }],
      maxOutputTokens: 37,
    },
    transport,
    () => transport.assertCurrent(),
    onText,
  );
}
function frames(
  family: AiConnectionDraft["family"],
  text: string,
  complete = true,
) {
  const values =
    family === "openai_responses"
      ? [{ type: "response.output_text.delta", delta: text }]
      : [{ choices: [{ delta: { content: text } }] }];
  const data = values.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`);
  if (complete)
    data.push(
      family === "openai_responses"
        ? 'data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n'
        : "data: [DONE]\r\n\r\n",
    );
  return data.join("");
}
function wireReply(
  response: ServerResponse,
  family: AiConnectionDraft["family"],
  stream: boolean,
  text = "Azure 雪",
) {
  if (!stream) {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        family === "openai_responses"
          ? {
              status: "completed",
              output: [
                { type: "message", content: [{ type: "output_text", text }] },
              ],
            }
          : { choices: [{ message: { content: text } }] },
      ),
    );
    return;
  }
  response.setHeader("content-type", "text/event-stream");
  const bytes = Buffer.from(frames(family, text));
  const boundary = Math.max(9, bytes.indexOf(Buffer.from("雪")) + 1);
  response.write(bytes.subarray(0, 7));
  setImmediate(() => {
    if (response.destroyed) return;
    response.write(bytes.subarray(7, boundary));
    setImmediate(() => response.end(bytes.subarray(boundary)));
  });
}

function checkWire(
  request: CapturedAiRequest | undefined,
  entry: Contract,
  stream: boolean,
  tokenParameter: AiConnectionDraft["tokenParameter"],
) {
  if (!request)
    throw new Error("The owned Azure HTTP fixture received no request.");
  expect(request.method).toBe("POST");
  const route =
    entry.api === "dated-chat"
      ? `deployments/${deployment}/chat/completions?api-version=2024-06-01`
      : `v1/${entry.family === "openai_chat" ? "chat/completions" : "responses"}`;
  expect(request.path).toBe(`/custom/v1/openai/${route}`);
  expect(request.headers["api-key"]).toBe(
    entry.credential === "api-key" ? key : undefined,
  );
  expect(request.headers.authorization).toBe(
    entry.credential === "entra-token" ? `Bearer ${key}` : undefined,
  );
  expect(request.headers.cookie).toBeUndefined();
  expect(request.headers["x-api-key"]).toBeUndefined();
  expect(request.headers["x-goog-api-key"]).toBeUndefined();
  const common = { model: deployment, stream };
  const messages = [{ role: "user", content: "Hello" }];
  expect(JSON.parse(request.body)).toEqual(
    entry.family === "openai_responses"
      ? { ...common, input: messages, max_output_tokens: 37 }
      : { ...common, messages, [tokenParameter]: 37 },
  );
  expect(request.path).not.toContain(key);
}

it.each(cases)(
  "$providerId $api $family $credential returns real JSON and split SSE answers",
  async (entry) => {
    const fixture = await aiHttpFixture((request, response) => {
      wireReply(response, entry.family, JSON.parse(request.body).stream);
    });
    cleanups.push(fixture.close);
    const draft = draftAt(fixture.baseUrl, entry);
    for (const tokenParameter of [
      "max_tokens",
      "max_completion_tokens",
    ] as const) {
      draft.tokenParameter = tokenParameter;
      for (const stream of [false, true]) {
        const before = fixture.requests.length;
        const chunks: string[] = [];
        const result = await infer(
          draft,
          fixture.transport,
          stream ? (text) => chunks.push(text) : undefined,
        );
        expect(result).toEqual({
          providerId: entry.providerId,
          model: deployment,
          answer: "Azure 雪",
        });
        expect(chunks.join("")).toBe(stream ? result.answer : "");
        expect(fixture.requests).toHaveLength(before + 1);
        checkWire(fixture.requests[before], entry, stream, tokenParameter);
      }
    }
  },
);

const v1 = { api: "v1", credential: "api-key" } as const;
function dated(apiVersion: string) {
  return { api: "dated-chat", apiVersion, credential: "api-key" };
}
function invalidTargets(baseUrl: string): [string, BoundaryObject][] {
  return [
    ["missing target", { azure: undefined }],
    ["null target", { azure: null }],
    ["foreign provider", { providerId: "openai" }],
    ["foreign family", { family: "anthropic_messages" }],
    ["no-auth target", { authentication: "none" }],
    ["unknown mode", { azure: { ...v1, api: "v2" } }],
    [
      "unknown credential",
      { azure: { ...v1, credential: "bearer\r\nInjected: x" } },
    ],
    ["extra headers", { azure: { ...v1, headers: { Cookie: "private" } } }],
    ["v1 dated query", { azure: { ...v1, apiVersion: "2024-06-01" } }],
    [
      "dated Responses",
      { azure: dated("2024-06-01"), family: "openai_responses" },
    ],
    ["invalid calendar date", { azure: dated("2024-02-31") }],
    ["version query injection", { azure: dated("2024-06-01&other=x") }],
    ["version header injection", { azure: dated("2024-06-01\r\nInjected: x") }],
    ["deployment parent", { model: "../other" }],
    ["deployment path", { model: "first/other" }],
    ["encoded deployment", { model: "first%2Fother" }],
    ["deployment query", { model: "first?api-version=other" }],
    ["deployment control", { model: "first\nother" }],
    ["URL credential", { baseUrl: "https://secret@azure.example" }],
    ["URL query", { baseUrl: `${baseUrl}?api-version=other` }],
    ["URL fragment", { baseUrl: `${baseUrl}#other` }],
    ["encoded base traversal", { baseUrl: `${baseUrl}/%2e%2e/other` }],
    ["credential in deployment", { model: key }],
    ["credential in mount", { baseUrl: `${baseUrl}/${key}` }],
  ];
}
it("refuses invalid targets before any real HTTP", async () => {
  const fixture = await aiHttpFixture((_request, response) => response.end());
  cleanups.push(fixture.close);
  for (const [name, patch] of invalidTargets(fixture.baseUrl)) {
    const draft = draftAt(fixture.baseUrl);
    for (const [field, value] of Object.entries(patch))
      Reflect.set(draft, field, value);
    await expect(infer(draft, fixture.transport), name).rejects.toMatchObject({
      code: "configuration",
    });
    expect(fixture.requests, name).toHaveLength(0);
  }
});

it.each(["", "bad key", "bad\r\nkey", "x".repeat(16385)])(
  "rejects an invalid write-only credential before HTTP (%#)",
  async (apiKey) => {
    const fixture = await aiHttpFixture((_request, response) => response.end());
    cleanups.push(fixture.close);
    await expect(
      infer({ ...draftAt(fixture.baseUrl), apiKey }, fixture.transport),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(fixture.requests).toHaveLength(0);
  },
);

it("never follows a real redirect with either Azure credential", async () => {
  const destination = await aiHttpFixture((_request, response) =>
    response.end(),
  );
  cleanups.push(destination.close);
  const fixture = await aiHttpFixture((_request, response) => {
    response.writeHead(302, { Location: `${destination.baseUrl}/stolen` });
    response.end();
  });
  cleanups.push(fixture.close);
  for (const credential of ["api-key", "entra-token"] as const) {
    const draft = draftAt(fixture.baseUrl);
    draft.azure = { api: "v1", credential };
    await expect(infer(draft, fixture.transport)).rejects.toMatchObject({
      code: "network",
    });
  }
  expect(fixture.requests).toHaveLength(2);
  expect(destination.requests).toHaveLength(0);
});

it.each(["openai_chat", "openai_responses"] as const)(
  "refuses %s credential leakage and incomplete SSE through real HTTP",
  async (family) => {
    const fixture = await aiHttpFixture((request, response) => {
      wireReply(response, family, JSON.parse(request.body).stream, key);
    });
    cleanups.push(fixture.close);
    const draft = { ...draftAt(fixture.baseUrl), family };
    for (const stream of [false, true]) {
      const chunks: string[] = [];
      await expect(
        infer(
          draft,
          fixture.transport,
          stream ? (text) => chunks.push(text) : undefined,
        ),
      ).rejects.toMatchObject({ code: "response" });
      expect(chunks.join("")).not.toContain(key);
    }
    const incomplete = await aiHttpFixture((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.end(frames(family, "partial", false));
    });
    cleanups.push(incomplete.close);
    await expect(
      infer(
        { ...draft, baseUrl: incomplete.baseUrl },
        incomplete.transport,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "response" });
  },
);

it.each(["abort", "stale"])(
  "closes an actual pending SSE body on %s",
  async (kind) => {
    let closed = false;
    const fixture = await aiHttpFixture((_request, response) => {
      response.on("close", () => {
        closed = true;
      });
      response.setHeader("content-type", "text/event-stream");
      response.write(frames("openai_chat", "first", false));
    });
    cleanups.push(fixture.close);
    let current = true;
    const transport = {
      ...fixture.transport,
      assertCurrent() {
        fixture.transport.assertCurrent();
        if (!current)
          throw new AiConnectionError("stale", "Azure owner changed.");
      },
    };
    const chunks: string[] = [];
    const pending = infer(draftAt(fixture.baseUrl), transport, (text) => {
      chunks.push(text);
      if (kind === "abort") fixture.lifetime.abort();
      else current = false;
    });
    await expect(pending).rejects.toMatchObject(
      kind === "abort" ? { name: "AbortError" } : { code: "stale" },
    );
    expect(chunks).toEqual(["first"]);
    await expect.poll(() => closed).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    await expect(
      infer(draftAt(fixture.baseUrl), transport),
    ).rejects.toBeDefined();
    expect(fixture.requests).toHaveLength(1);
  },
);
