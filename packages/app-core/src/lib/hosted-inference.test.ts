import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performHostedInference } from "./hosted-inference.js";
import {
  type HostedModelProvider,
  hostedModelRequest,
} from "./hosted-model-protocol.js";
import {
  MODEL_TEST_SECRET,
  modelMemoryBackend,
  saveModelFixture,
} from "./hosted-model.test-support.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";

beforeEach(modelMemoryBackend);
afterEach(() => vi.restoreAllMocks());
const input = {
  model: "chosen-model",
  messages: [{ role: "user" as const, content: "Where is lock?" }],
};
const contracts = [
  {
    provider: "anthropic",
    url: "https://api.anthropic.com/v1/messages",
    header: "x-api-key",
    credential: MODEL_TEST_SECRET,
    reply: {
      type: "message",
      content: [{ type: "text", text: "Lock is in the sidebar." }],
    },
  },
  {
    provider: "openai",
    url: "https://api.openai.com/v1/chat/completions",
    header: "authorization",
    credential: `Bearer ${MODEL_TEST_SECRET}`,
    reply: { choices: [{ message: { content: "Lock is in the sidebar." } }] },
  },
  {
    provider: "openrouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    header: "authorization",
    credential: `Bearer ${MODEL_TEST_SECRET}`,
    reply: { choices: [{ message: { content: "Lock is in the sidebar." } }] },
  },
  {
    provider: "huggingface",
    url: "https://router.huggingface.co/v1/chat/completions",
    header: "authorization",
    credential: `Bearer ${MODEL_TEST_SECRET}`,
    reply: { choices: [{ message: { content: "Lock is in the sidebar." } }] },
  },
  {
    provider: "gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/models/chosen-model:generateContent",
    header: "x-goog-api-key",
    credential: MODEL_TEST_SECRET,
    reply: {
      candidates: [
        { content: { parts: [{ text: "Lock is in the sidebar." }] } },
      ],
    },
  },
] satisfies {
  provider: HostedModelProvider;
  url: string;
  header: string;
  credential: string;
  reply: BoundaryValue;
}[];
describe("awaited hosted inference", () => {
  it.each(contracts)(
    "executes $provider's real protocol and returns only the decoded answer",
    async (contract) => {
      const id = await saveModelFixture(contract.provider);
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get(contract.header)).toBe(contract.credential);
        expect(JSON.stringify(init?.body)).not.toContain(MODEL_TEST_SECRET);
        expect(String(init?.body)).toContain("Where is lock?");
        expect(init).toMatchObject({
          method: "POST",
          redirect: "error",
          credentials: "omit",
          mode: "cors",
        });
        if (contract.provider === "anthropic") {
          expect(headers.get("anthropic-version")).toBe("2023-06-01");
          expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe(
            "true",
          );
        }
        return Response.json(contract.reply);
      });
      const result = await performHostedInference(id, input, {
        fetch,
        signal: new AbortController().signal,
        assertCurrent() {},
      });
      expect(String(fetch.mock.calls[0]?.[0])).toBe(contract.url);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        providerId: contract.provider,
        model: "chosen-model",
        answer: "Lock is in the sidebar.",
      });
      expect(JSON.stringify(result)).not.toContain(MODEL_TEST_SECRET);
    },
  );
  it("waits for the actual response instead of accepting delivery", async () => {
    const id = await saveModelFixture("openai");
    let respond: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const done = vi.fn();
    const result = performHostedInference(id, input, {
      fetch,
      signal: new AbortController().signal,
      assertCurrent() {},
    }).then(done);
    await vi.waitFor(() => expect(respond).toBeDefined());
    expect(done).not.toHaveBeenCalled();
    respond?.(
      Response.json({ choices: [{ message: { content: "Actual answer" } }] }),
    );
    await result;
    expect(done).toHaveBeenCalledWith({
      providerId: "openai",
      model: "chosen-model",
      answer: "Actual answer",
    });
  });
  it.each([
    {},
    {
      error: { message: "Bad key" },
      choices: [{ message: { content: "Bogus success" } }],
    },
    { error: { message: MODEL_TEST_SECRET } },
    { choices: [{ message: { content: MODEL_TEST_SECRET } }] },
  ])(
    "refuses malformed, provider-error, and reflected-credential responses",
    async (reply) => {
      const id = await saveModelFixture("openai");
      await expect(
        performHostedInference(id, input, {
          fetch: vi.fn(async () => Response.json(reply)),
          signal: new AbortController().signal,
          assertCurrent() {},
        }),
      ).rejects.toThrow();
    },
  );
  it("refuses configured-only, disabled, unsupported, and already-aborted models without network", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runtime = {
      fetch,
      signal: new AbortController().signal,
      assertCurrent() {},
    };
    const pending = await saveModelFixture("openai", false);
    await expect(
      performHostedInference(pending, input, runtime),
    ).rejects.toThrow("Verify");
    const unsupported = await saveModelFixture("azure-openai");
    await expect(
      performHostedInference(unsupported, input, runtime),
    ).rejects.toThrow("supported");
    await expect(
      performHostedInference(pending, input, {
        ...runtime,
        assertCurrent() {
          throw new Error("Disabled");
        },
      }),
    ).rejects.toThrow("Disabled");
    await expect(
      performHostedInference(pending, input, {
        ...runtime,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a response when the saved connection changes during inference", async () => {
    const id = await saveModelFixture("openai");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const view = readNativeConnector(id);
      if (!view) throw new Error("Missing fixture");
      await updateNativeConnector(
        id,
        { revision: view.revision, fingerprint: view.fingerprint },
        { publicParameters: [], privateCredentials: ["api_key"] },
        (current) => ({
          ...current,
          configuration: {
            ...current.configuration,
            displayName: "Changed model",
          },
        }),
      );
      return Response.json({
        choices: [{ message: { content: "Late answer" } }],
      });
    });
    await expect(
      performHostedInference(id, input, {
        fetch,
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    ).rejects.toThrow("changed");
  });
  it("refuses prompts containing the saved credential before sending", async () => {
    const id = await saveModelFixture("openai");
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      performHostedInference(
        id,
        { ...input, messages: [{ role: "user", content: MODEL_TEST_SECRET }] },
        { fetch, signal: new AbortController().signal, assertCurrent() {} },
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects late answers after the capability lease is revoked", async () => {
    const id = await saveModelFixture("openai");
    let active = true;
    const runtime = {
      fetch: vi.fn<typeof globalThis.fetch>(async () => {
        active = false;
        return Response.json({
          choices: [{ message: { content: "Late answer" } }],
        });
      }),
      signal: new AbortController().signal,
      assertCurrent() {
        if (!active) throw new Error("Lease revoked");
      },
    };
    await expect(performHostedInference(id, input, runtime)).rejects.toThrow();
  });
  it("rejects Gemini path injection and bounds model input before sending", () => {
    expect(() =>
      hostedModelRequest("gemini", { ...input, model: "../other" }),
    ).toThrow();
    expect(() =>
      hostedModelRequest("openai", { ...input, maxOutputTokens: 99999 }),
    ).toThrow();
    expect(() =>
      hostedModelRequest("openai", {
        ...input,
        messages: [{ role: "user", content: "a".repeat(9000) }],
      }),
    ).toThrow();
  });
});
