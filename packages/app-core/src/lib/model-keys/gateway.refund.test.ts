import type { BoundaryObject, BoundaryValue } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HostedModelAuthority,
  type HostedModelFence,
  type HostedModelOperation,
  bindHostedModelAuthority,
} from "../hosted-model-authority.js";
import {
  MODEL_TEST_SECRET,
  modelMemoryBackend,
  saveModelFixture,
} from "../hosted-model.test-support.js";
import { bindModelKeyBroker } from "./active.js";
import { invokeWithModelKey } from "./gateway.js";
import { expectRefused, harness } from "./harness.test-support.js";
import { inspectCall } from "./protocols.js";

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
});

const START = { requests: 100, input_tokens: 100_000, output_tokens: 50_000 };

/** An authority that runs `script`; `dispatch` is what the real one does just before a request can leave. */
function authority(script: (dispatch: () => void) => Promise<BoundaryValue>) {
  const seen = { executed: 0 };
  const bound: HostedModelAuthority = {
    fetch: vi.fn(),
    assertCurrent: () => undefined,
    read: () => null,
    connections: () => [],
    execute: async (_id, definition: HostedModelOperation) => {
      seen.executed += 1;
      return script(() => definition.onDispatch?.());
    },
  };
  releases.push(bindHostedModelAuthority(bound));
  return seen;
}

function fence(): HostedModelFence {
  return {
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
    fetch: vi.fn(),
  };
}

async function setup() {
  const h = harness({ senderConstraint: "dpop_optional" });
  releases.push(bindModelKeyBroker(h.broker));
  const root = await h.root(null);
  const spend = (body: BoundaryObject = h.chat()) =>
    invokeWithModelKey(
      { token: root.token, clientId: "app-1" },
      {
        operation: "invoke",
        method: "POST",
        path: "/chat/completions",
        resource: "https://api.openai.com/v1",
        body,
      },
      fence(),
    );
  const remaining = () => h.broker.list()[0]?.remaining;
  return { h, spend, remaining };
}

const messages = (count: number) =>
  Array.from({ length: count }, () => ({ role: "user", content: "x" }));

describe("a request too large for the authority", () => {
  it("is refused at inspection, and the key's budget is untouched", async () => {
    const { h, spend, remaining } = await setup();
    const seen = authority(async () => ({}));
    await expectRefused(
      spend(h.chat({ messages: messages(101) })),
      "invalid_request",
      "body.limits",
    );
    expect(seen.executed).toBe(0);
    expect(remaining()).toEqual(START);
  });

  it("is refused again and again without ever costing a request", async () => {
    const { h, spend, remaining } = await setup();
    authority(async () => ({}));
    for (let attempt = 0; attempt < 5; attempt++)
      await expectRefused(
        spend(h.chat({ messages: messages(101) })),
        "invalid_request",
        "body.limits",
      );
    expect(remaining()).toEqual(START);
  });
});

describe("what a call costs when it fails", () => {
  it("is nothing when the authority refuses it before a request can leave", async () => {
    const { spend, remaining } = await setup();
    const seen = authority(async () => {
      throw new Error("Provider request is too large");
    });
    await expect(spend()).rejects.toThrow("Provider request is too large");
    expect(seen.executed).toBe(1);
    expect(remaining()).toEqual(START);
  });

  it("is the worst case when it fails after the request may have left", async () => {
    const { spend, remaining } = await setup();
    authority(async (dispatch) => {
      dispatch();
      throw new Error("network down");
    });
    await expect(spend()).rejects.toThrow("network down");
    expect(remaining()).toMatchObject({
      requests: 99,
      output_tokens: START.output_tokens - 100,
    });
    expect(remaining()?.input_tokens).toBeLessThan(START.input_tokens);
  });

  it("is the worst case when an abort lands in flight", async () => {
    const { spend, remaining } = await setup();
    authority(async (dispatch) => {
      dispatch();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(spend()).rejects.toThrow("aborted");
    expect(remaining()?.requests).toBe(99);
  });

  it("is what the provider reported, when the authority answers", async () => {
    const { spend, remaining } = await setup();
    authority(async (dispatch) => {
      dispatch();
      return { usage: { prompt_tokens: 12, completion_tokens: 7 } };
    });
    await spend();
    expect(remaining()).toEqual({
      requests: 99,
      input_tokens: START.input_tokens - 12,
      output_tokens: START.output_tokens - 7,
    });
  });

  it("is never less than a sent call, whatever an answering authority forgot to say", async () => {
    const { spend, remaining } = await setup();
    authority(async () => ({
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    }));
    await spend();
    expect(remaining()?.requests).toBe(99);
  });
});

/** The real `executeNativeApiRequest`, behind the saved connection fixture, with a provider that can be told to fail. */
describe("the real authority", () => {
  async function real(
    provider: (init?: RequestInit) => Response | Promise<Response>,
  ) {
    modelMemoryBackend();
    await saveModelFixture("openai");
    const h = harness({ senderConstraint: "dpop_optional" });
    h.connections.set("openai", { providerId: "openai", verified: true });
    releases.push(bindModelKeyBroker(h.broker));
    const root = await h.root(null, { connectionId: "openai" });
    const fetched = vi.fn<typeof fetch>(async (_url, init) => provider(init));
    const spend = (body: BoundaryObject) =>
      invokeWithModelKey(
        { token: root.token, clientId: "app-1" },
        {
          operation: "invoke",
          method: "POST",
          path: "/chat/completions",
          resource: "https://api.openai.com/v1",
          body,
        },
        { ...fence(), fetch: fetched },
      );
    return {
      h,
      spend,
      fetched,
      remaining: () => h.broker.list()[0]?.remaining,
    };
  }
  const answer = () =>
    Response.json({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    });

  it("refunds a call it refused before dispatch: the saved credential in the body", async () => {
    const { h, spend, fetched, remaining } = await real(answer);
    await expect(
      spend(
        h.chat({
          messages: [{ role: "user", content: `key ${MODEL_TEST_SECRET}` }],
        }),
      ),
    ).rejects.toThrow();
    expect(fetched).not.toHaveBeenCalled();
    expect(remaining()).toEqual(START);
  });

  it("charges a call the provider refused: it was sent", async () => {
    const { h, spend, fetched, remaining } = await real(
      () => new Response("{}", { status: 500 }),
    );
    await expect(spend(h.chat())).rejects.toThrow();
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(remaining()?.requests).toBe(99);
  });

  it("charges a call that dropped on the wire: it may have left", async () => {
    const { h, spend, fetched, remaining } = await real(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(spend(h.chat())).rejects.toThrow();
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(remaining()?.requests).toBe(99);
  });

  it("charges a call whose answer it could not accept: the request went out", async () => {
    const { h, spend, fetched, remaining } = await real(() =>
      Response.json({ choices: Array.from({ length: 101 }, () => ({})) }),
    );
    await expect(spend(h.chat())).rejects.toThrow();
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(remaining()?.requests).toBe(99);
  });

  it("charges what the provider reported on success", async () => {
    const { h, spend, remaining } = await real(answer);
    await spend(h.chat());
    expect(remaining()).toEqual({
      requests: 99,
      input_tokens: START.input_tokens - 9,
      output_tokens: START.output_tokens - 4,
    });
  });
});

/** What inspection admits, `executeNativeApiRequest` must accept; the real one is the oracle. */
describe("what inspection admits and what the authority accepts", () => {
  const nest = (levels: number, leaf: BoundaryValue): BoundaryObject => {
    let value: BoundaryValue = leaf;
    for (let i = 0; i < levels; i++) value = { a: value };
    return { type: "object", properties: value };
  };
  const tool = (parameters: BoundaryObject) => ({
    type: "function",
    function: { name: "f", parameters },
  });
  const keys = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`k${i}`, { type: "string" }]),
    );
  // [label, at the limit, one past it]
  const limits: readonly [string, BoundaryObject, BoundaryObject][] = [
    [
      "an array of 100 items",
      { messages: messages(100) },
      { messages: messages(101) },
    ],
    [
      "a string of 65536 characters",
      { messages: [{ role: "user", content: "x".repeat(65_536) }] },
      { messages: [{ role: "user", content: "x".repeat(65_537) }] },
    ],
    [
      "an object of 100 keys",
      { tools: [tool({ type: "object", properties: keys(100) })] },
      { tools: [tool({ type: "object", properties: keys(101) })] },
    ],
    [
      "a key of 4096 characters",
      { tools: [tool({ [`${"k".repeat(4_096)}`]: 1 })] },
      { tools: [tool({ [`${"k".repeat(4_097)}`]: 1 })] },
    ],
    [
      "ten levels of nesting",
      // tools(1) item(2) function(3) parameters(4) properties(5), then the chain: the leaf is at depth 5 + levels
      { tools: [tool(nest(5, "x"))] },
      { tools: [tool(nest(6, "x"))] },
    ],
  ];

  it.each(limits)("%s", async (_label, within, over) => {
    // The inspected body is what goes out: the real authority must take it.
    const rig = async () => {
      modelMemoryBackend();
      await saveModelFixture("openai");
      const h = harness({ senderConstraint: "dpop_optional" });
      h.connections.set("openai", { providerId: "openai", verified: true });
      releases.push(bindModelKeyBroker(h.broker));
      return { h, root: await h.root(null, { connectionId: "openai" }) };
    };
    const { h, root } = await rig();
    const fetched = vi.fn<typeof fetch>(async () =>
      Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    const send = (body: BoundaryObject) =>
      invokeWithModelKey(
        { token: root.token, clientId: "app-1" },
        {
          operation: "invoke",
          method: "POST",
          path: "/chat/completions",
          resource: "https://api.openai.com/v1",
          body,
        },
        { ...fence(), fetch: fetched },
      );
    await send(h.chat(within));
    expect(fetched).toHaveBeenCalledTimes(1);
    await expectRefused(send(h.chat(over)), "invalid_request", "body.limits");
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(h.broker.list()[0]?.remaining.requests).toBe(99);
  });

  it("reads the same limits for every protocol", () => {
    const body = { contents: [{ parts: messages(101) }] };
    expect(() =>
      inspectCall({
        protocol: "gemini_generate_content",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        operation: "invoke",
        method: "POST",
        path: "/models/gemini-2.5-flash:generateContent",
        body: { ...body, generationConfig: { maxOutputTokens: 5 } },
      }),
    ).toThrow(expect.objectContaining({ reason: "body.limits" }));
  });
});
