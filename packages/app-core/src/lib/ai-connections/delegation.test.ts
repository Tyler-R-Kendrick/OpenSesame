import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  aiDelegationAvailable,
  executeAiDelegatedRequest,
} from "./delegation.js";
import {
  DELEGATED_SECRET,
  canonicalCall,
  canonicalDraft,
  delegatedAnswer,
  delegationFence,
  delegationFixture,
} from "./delegation.test-support.js";
import { aiConnectionDraft } from "./presets.js";
import { saveAiConnection } from "./runtime.js";

let fixture: Awaited<ReturnType<typeof delegationFixture>>;
beforeEach(async () => {
  fixture = await delegationFixture();
});
afterEach(async () => {
  await fixture.close();
});

it.each(["openai", "anthropic", "gemini"] as const)(
  "delegates the canonical %s family with its real vault key and preserves raw usage",
  async (providerId) => {
    const id = await fixture.save(providerId);
    expect(aiDelegationAvailable(id)).toBe(true);
    const { definition, body, resource } = canonicalCall(providerId);
    const onDispatch = vi.fn();
    const fence = delegationFence();
    const answer = await executeAiDelegatedRequest(
      id,
      { ...definition, onDispatch },
      body,
      (value) => value,
      fence,
    );
    expect(answer).toEqual(delegatedAnswer(providerId));
    expect(fixture.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fixture.fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${new URL(resource).origin}${definition.path}`);
    const headers = new Headers(init?.headers);
    const header =
      providerId === "openai"
        ? "authorization"
        : providerId === "anthropic"
          ? "x-api-key"
          : "x-goog-api-key";
    expect(headers.get(header)).toBe(
      providerId === "openai" ? `Bearer ${DELEGATED_SECRET}` : DELEGATED_SECRET,
    );
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(fence.fetch).not.toHaveBeenCalled();
  },
);

it.each(["foreign-host", "foreign-path", "responses", "byo"])(
  "refuses %s at admission and execution before dispatch",
  async (kind) => {
    const draft = canonicalDraft();
    if (kind === "foreign-host") draft.baseUrl = "https://models.example/v1";
    if (kind === "foreign-path")
      draft.baseUrl = "https://api.openai.com/another/v1";
    if (kind === "responses") draft.family = "openai_responses";
    const chosen =
      kind === "byo"
        ? {
            ...aiConnectionDraft("byo-ai"),
            baseUrl: draft.baseUrl,
            model: draft.model,
            apiKey: draft.apiKey,
          }
        : draft;
    if (kind === "responses")
      fixture.fetcher.mockImplementationOnce(async () =>
        Response.json({
          status: "completed",
          output: [
            { type: "message", content: [{ type: "output_text", text: "OK" }] },
          ],
        }),
      );
    const saved = await saveAiConnection(chosen);
    fixture.fetcher.mockClear();
    expect(aiDelegationAvailable(saved.connectionId)).toBe(false);
    const call = canonicalCall();
    const onDispatch = vi.fn();
    await expect(
      executeAiDelegatedRequest(
        saved.connectionId,
        { ...call.definition, onDispatch },
        call.body,
        (value) => value,
        delegationFence(),
      ),
    ).rejects.toThrow(/canonical|delegation/);
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(onDispatch).not.toHaveBeenCalled();
  },
);

it.each([
  "origin",
  "route",
  "protocol",
  "model",
  "stream",
  "unpriced-field",
  "credential-header",
])("re-inspects and refuses an unapproved %s before dispatch", async (kind) => {
  const id = await fixture.save();
  const { definition } = canonicalCall();
  const body = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Question" }],
    max_tokens: 100,
    stream: false,
  };
  if (kind === "origin") definition.origin = "https://attacker.example";
  if (kind === "route") definition.path = "/v1/chat/completions/../responses";
  if (kind === "protocol") definition.path = "/v1/responses";
  if (kind === "model") body.model = "gpt-4";
  if (kind === "stream") body.stream = true;
  if (kind === "credential-header")
    definition.headers = { authorization: "Bearer attacker-key" };
  const sentBody =
    kind === "unpriced-field" ? { ...body, web_search: true } : body;
  await expect(
    executeAiDelegatedRequest(
      id,
      definition,
      sentBody,
      (value) => value,
      delegationFence(),
    ),
  ).rejects.toThrow();
  expect(fixture.fetcher).not.toHaveBeenCalled();
});

it("supports inspected model listing without a body or credential leak", async () => {
  const id = await fixture.save();
  const { definition } = canonicalCall();
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ data: [{ id: "gpt-4o" }] }),
  );
  const answer = await executeAiDelegatedRequest(
    id,
    {
      ...definition,
      operationId: "model.list",
      method: "GET",
      path: "/v1/models",
    },
    null,
    (value) => value,
    delegationFence(),
  );
  expect(answer).toEqual({ data: [{ id: "gpt-4o" }] });
  expect(fixture.fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ nested: { leaked: DELEGATED_SECRET } }),
  );
  const call = canonicalCall();
  await expect(
    executeAiDelegatedRequest(
      id,
      call.definition,
      call.body,
      (value) => value,
      delegationFence(),
    ),
  ).rejects.toMatchObject({ code: "response" });
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({
      data: Array.from({ length: 101 }, () => "oversized-provider-list"),
    }),
  );
  await expect(
    executeAiDelegatedRequest(
      id,
      call.definition,
      call.body,
      (value) => value,
      delegationFence(),
    ),
  ).rejects.toMatchObject({ code: "response" });
});
