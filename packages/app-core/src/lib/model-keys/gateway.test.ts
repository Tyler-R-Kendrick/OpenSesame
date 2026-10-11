import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HostedModelAuthority,
  type HostedModelFence,
  type HostedModelOperation,
  bindHostedModelAuthority,
} from "../hosted-model-authority.js";
import {
  activeModelKeyBroker,
  bindModelKeyBroker,
  modelKeysVersion,
  subscribeModelKeys,
} from "./active.js";
import { invokeWithModelKey } from "./gateway.js";
import { ANTHROPIC, expectRefused, harness } from "./harness.test-support.js";

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
});

type Sent = {
  connectionId: string;
  definition: HostedModelOperation;
  body: BoundaryValue;
};

function authority(
  reply: () => Promise<BoundaryValue> = async () => ({
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  }),
) {
  const sent: Sent[] = [];
  const bound: HostedModelAuthority = {
    fetch: vi.fn(),
    assertCurrent: () => undefined,
    read: () => null,
    connections: () => [],
    execute: async (connectionId, definition, body) => {
      sent.push({ connectionId, definition, body });
      return reply();
    },
  };
  releases.push(bindHostedModelAuthority(bound));
  return sent;
}

function fence(signal = new AbortController().signal): HostedModelFence {
  return { signal, assertCurrent: () => undefined, fetch: vi.fn() };
}

async function setup() {
  const h = harness({ senderConstraint: "dpop_optional" });
  releases.push(bindModelKeyBroker(h.broker));
  const root = await h.root(null);
  return { h, root };
}

const chat = (h: Awaited<ReturnType<typeof setup>>["h"]) => ({
  operation: "invoke" as const,
  method: "POST",
  path: "/chat/completions",
  body: h.chat(),
  resource: "https://api.openai.com/v1",
});

describe("spending a key", () => {
  it("sends only to the host the catalog names, with the body the broker inspected", async () => {
    const { h, root } = await setup();
    const sent = authority();
    const result = await invokeWithModelKey(
      { token: root.token, clientId: "app-1" },
      chat(h),
      fence(),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.connectionId).toBe("conn-openai");
    expect(sent[0]?.definition).toMatchObject({
      providerId: "openai",
      method: "POST",
      origin: "https://api.openai.com",
      path: "/v1/chat/completions",
    });
    expect(sent[0]?.body).toEqual(h.chat());
    expect(result).toMatchObject({ providerId: "openai", model: "gpt-4o" });
    expect(h.broker.list()[0]?.remaining.requests).toBe(99);
  });

  it("charges what the provider reported, not the worst case", async () => {
    const { h, root } = await setup();
    authority();
    await invokeWithModelKey(
      { token: root.token, clientId: "app-1" },
      chat(h),
      fence(),
    );
    const [view] = h.broker.list();
    expect(view?.remaining.output_tokens).toBe(50_000 - 7);
    expect(view?.remaining.input_tokens).toBe(100_000 - 12);
  });

  it("never lets the caller add a header, a host or a route of its own", async () => {
    const { h, root } = await setup();
    const sent = authority();
    await expectRefused(
      invokeWithModelKey(
        { token: root.token, clientId: "app-1" },
        { ...chat(h), path: "/chat/completions/../../admin" },
        fence(),
      ),
      "insufficient_scope",
      "call.route",
    );
    await expectRefused(
      invokeWithModelKey(
        { token: root.token, clientId: "app-1" },
        { ...chat(h), resource: "https://evil.example.test/v1" },
        fence(),
      ),
      "invalid_token",
      "aud.mismatch",
    );
    expect(sent).toHaveLength(0);
  });

  it("keeps the charge when the send fails after it may have left, and frees the slot", async () => {
    const { h, root } = await setup();
    authority(async () => {
      throw new Error("network down");
    });
    await expect(
      invokeWithModelKey(
        { token: root.token, clientId: "app-1" },
        chat(h),
        fence(),
      ),
    ).rejects.toThrow("network down");
    const [view] = h.broker.list();
    expect(view?.remaining.requests).toBe(99);
    // The slot is free: eight more can be reserved, so none was leaked.
    for (let i = 0; i < 8; i++)
      await h.call(root.token, null, { body: h.chat() });
  });

  it("refunds a call stopped before anything left", async () => {
    const { h, root } = await setup();
    const sent = authority();
    const stop = new AbortController();
    stop.abort();
    await expect(
      invokeWithModelKey(
        { token: root.token, clientId: "app-1" },
        chat(h),
        fence(stop.signal),
      ),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
    expect(h.broker.list()[0]?.remaining.requests).toBe(100);
  });

  it("sends the headers Anthropic needs for a browser, from the protocol and nowhere else", async () => {
    const { h } = await setup();
    const key = await h.root(null, {
      clientId: "app-2",
      connectionId: "conn-anthropic",
      resource: ANTHROPIC.baseUrl,
      models: ["claude-sonnet-5-5"],
    });
    const sent = authority();
    await invokeWithModelKey(
      { token: key.token, clientId: "app-2" },
      {
        operation: "invoke",
        method: "POST",
        path: "/messages",
        resource: ANTHROPIC.baseUrl,
        body: {
          model: "claude-sonnet-5-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        },
      },
      fence(),
    );
    expect(sent[0]?.definition.headers).toEqual({
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    expect(sent[0]?.definition.origin).toBe("https://api.anthropic.com");
  });

  it("refuses when no broker or no authority is bound", async () => {
    const { h, root } = await setup();
    await expectRefused(
      invokeWithModelKey(
        { token: root.token, clientId: "app-1" },
        chat(h),
        fence(),
      ),
      "access_denied",
      "authority.unavailable",
    );
    for (const release of releases.splice(0)) release();
    await expectRefused(
      invokeWithModelKey(
        { token: root.token, clientId: "app-1" },
        chat(h),
        fence(),
      ),
      "access_denied",
      "broker.unavailable",
    );
  });
});

describe("the page's broker", () => {
  it("is forgotten, with every key in it, when its activation ends", async () => {
    const { h, root } = await setup();
    expect(activeModelKeyBroker()).toBe(h.broker);
    expect(h.broker.list()).toHaveLength(1);
    for (const release of releases.splice(0)) release();
    expect(activeModelKeyBroker()).toBeNull();
    expect(h.broker.list()).toHaveLength(0);
    await expectRefused(
      h.call(root.token, null, { body: h.chat() }),
      "invalid_token",
      "key.inactive",
    );
  });

  it("is not released by the release of one it replaced", async () => {
    const first = harness();
    const second = harness();
    const releaseFirst = bindModelKeyBroker(first.broker);
    releases.push(bindModelKeyBroker(second.broker));
    releaseFirst();
    expect(activeModelKeyBroker()).toBe(second.broker);
  });

  it("tells watchers when the keys change", async () => {
    const h = harness({ senderConstraint: "dpop_optional" });
    const seen = vi.fn();
    releases.push(subscribeModelKeys(seen));
    const before = modelKeysVersion();
    releases.push(bindModelKeyBroker(h.broker));
    expect(seen).toHaveBeenCalled();
    expect(modelKeysVersion()).toBeGreaterThan(before);
  });
});
