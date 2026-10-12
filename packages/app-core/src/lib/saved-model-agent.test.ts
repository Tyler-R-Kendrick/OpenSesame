import { fakeSupportPageContext } from "@opensesame/support-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_TEST_SECRET,
  modelMemoryBackend,
  saveModelFixture,
} from "./hosted-model.test-support.js";
import { modelProviderRecord } from "./model-provider.js";
import { createSavedModelSupportAgent } from "./saved-model-agent.js";

beforeEach(modelMemoryBackend);
afterEach(() => vi.restoreAllMocks());
const record = modelProviderRecord({
  kind: "hosted",
  provider: "openai",
  endpoint: "https://unused.example",
  model: "gpt-4o",
});
const request = {
  question: "Where is lock? Email person@example.com, token=private-token",
  history: [{ role: "user" as const, text: "private history" }],
  context: fakeSupportPageContext(),
};
describe("saved model support", () => {
  it("sends the redacted original question to only the selected model and returns its actual answer", async () => {
    await saveModelFixture("openai");
    await saveModelFixture("anthropic");
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        choices: [{ message: { content: "Click Lock in the sidebar." } }],
      }),
    );
    const agent = createSavedModelSupportAgent(
      { fetch, assertCurrent() {} },
      record,
    );
    expect(agent).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(await agent?.availability()).toEqual({ kind: "ready" });
    expect(fetch).not.toHaveBeenCalled();
    const turn = await agent?.run(request, {
      signal: new AbortController().signal,
    });
    expect(turn?.answer).toBe("Click Lock in the sidebar.");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    const body = String(fetch.mock.calls[0]?.[1]?.body);
    expect(body).toContain("Where is lock?");
    expect(body).toContain("[redacted address]");
    for (const privateValue of [
      MODEL_TEST_SECRET,
      "person@example.com",
      "private-token",
      "private history",
    ])
      expect(body).not.toContain(privateValue);
  });
  it("requires an explicitly supplied capability transport and exactly one verified selection", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = { fetch, assertCurrent() {} };
    expect(createSavedModelSupportAgent(transport, record)).toBeNull();
    await saveModelFixture("openai");
    expect(createSavedModelSupportAgent(undefined, record)).toBeNull();
    await saveModelFixture("openai", true, "second-openai");
    expect(createSavedModelSupportAgent(transport, record)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("aborts in-flight requests on destroy and rejects later runs", async () => {
    await saveModelFixture("openai");
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("Cancelled")),
            { once: true },
          );
        }),
    );
    const agent = createSavedModelSupportAgent(
      { fetch, assertCurrent() {} },
      record,
    );
    if (!agent) throw new Error("Missing fixture agent");
    const running = agent.run(request, {
      signal: new AbortController().signal,
    });
    agent.destroy();
    await expect(running).rejects.toMatchObject({ code: "AGENT_ABORTED" });
    await expect(
      agent.run(request, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "AGENT_ABORTED" });
  });
  it("reports an error instead of a canned acceptance when the provider fails", async () => {
    await saveModelFixture("openai");
    const agent = createSavedModelSupportAgent(
      {
        fetch: async () =>
          Response.json(
            { error: { message: MODEL_TEST_SECRET } },
            { status: 429 },
          ),
        assertCurrent() {},
      },
      record,
    );
    await expect(
      agent?.run(request, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "AGENT_PROTOCOL_ERROR" });
  });
});
