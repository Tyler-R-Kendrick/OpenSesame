/** @vitest-environment jsdom */
import {
  MODEL_TEST_SECRET,
  modelMemoryBackend,
  saveModelFixture,
} from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import {
  activeModelKeyBroker,
  modelKeysVersion,
} from "@opensesame/app-core/lib/model-keys/active.js";
import { invokeWithModelKey } from "@opensesame/app-core/lib/model-keys/gateway.js";
import { mintModelKey } from "@opensesame/app-core/lib/model-keys/mint.js";
import { emitVaultLock } from "@opensesame/app-core/lib/vault/lock-events.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import {
  bindNativeModelKeys,
  connectionFacts,
} from "./native-model-keys-runtime.js";
import { bindNativeModelRuntime } from "./native-model-runtime.js";
import { bindNativeRuntime, bindProviderRuntime } from "./native-runtime.js";

const releases: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function activate() {
  const t = createTestContext();
  const fetcher = vi.fn<typeof t.ctx.egress.fetch>(async () =>
    Response.json({
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    }),
  );
  const ctx = { ...t.ctx, egress: { ...t.ctx.egress, fetch: fetcher } };
  const activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  bindNativeModelRuntime(activation);
  bindNativeModelKeys(activation);
  releases.push(activation.dispose);
  return { activation, fetcher };
}

const choice = () => ({
  clientId: "agent-1",
  connectionId: "openai",
  resource: "https://api.openai.com/v1",
  actions: ["model.invoke" as const],
  models: ["gpt-4o"],
  budget: {
    requests: 5,
    input_tokens: 10_000,
    output_tokens: 5_000,
    max_output_tokens: 512,
  },
  lifetimeSeconds: 600,
});

const call = {
  operation: "invoke" as const,
  method: "POST",
  path: "/chat/completions",
  resource: "https://api.openai.com/v1",
  body: {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 100,
  },
};

function fence() {
  return {
    signal: new AbortController().signal,
    assertCurrent() {},
    fetch: vi.fn<typeof fetch>(),
  };
}

it("a key spends the saved connection's credential and is never the one sent", async () => {
  modelMemoryBackend(false);
  await saveModelFixture("openai");
  const { fetcher } = activate();
  const { tomb } = await localRequestFixture();
  const key = await mintModelKey(tomb, choice());

  const result = await invokeWithModelKey(
    { token: key.token, clientId: "agent-1" },
    call,
    fence(),
  );

  expect(result.providerId).toBe("openai");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init, meta] = fetcher.mock.calls[0] ?? [];
  expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
  expect(meta?.capability).toBe("connectors.external");
  const headers = new Headers(init?.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${MODEL_TEST_SECRET}`);
  // The key stays on this side of the glass: nothing sent upstream carries it.
  const sent = JSON.stringify([
    String(url),
    [...headers.entries()],
    String(init?.body ?? ""),
  ]);
  expect(sent).not.toContain(key.token);
  expect(sent).not.toContain("osk_");
  expect(JSON.parse(String(init?.body))).toEqual(call.body);
});

it("a key for a model it was not narrowed to never reaches the provider", async () => {
  modelMemoryBackend(false);
  await saveModelFixture("openai");
  const { fetcher } = activate();
  const { tomb } = await localRequestFixture();
  const key = await mintModelKey(tomb, choice());
  await expect(
    invokeWithModelKey(
      { token: key.token, clientId: "agent-1" },
      { ...call, body: { ...call.body, model: "gpt-4" } },
      fence(),
    ),
  ).rejects.toMatchObject({ reason: "escalation.model" });
  await expect(
    invokeWithModelKey(
      { token: key.token, clientId: "someone-else" },
      call,
      fence(),
    ),
  ).rejects.toMatchObject({ reason: "key.foreign_client" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("only a verified API-key connection can back a key", async () => {
  modelMemoryBackend(false);
  await saveModelFixture("openai", false);
  activate();
  const { tomb } = await localRequestFixture();
  expect(connectionFacts("openai")).toMatchObject({ verified: false });
  expect(connectionFacts("nothing-saved")).toBeNull();
  await expect(mintModelKey(tomb, choice())).rejects.toMatchObject({
    reason: "draft.connection",
  });
});

it("a lock ends every key, and a disabled capability takes the broker with it", async () => {
  modelMemoryBackend(false);
  await saveModelFixture("openai");
  const { activation, fetcher } = activate();
  const { tomb } = await localRequestFixture();
  const key = await mintModelKey(tomb, choice());
  const broker = activeModelKeyBroker();
  expect(broker?.list()).toHaveLength(1);
  const before = modelKeysVersion();

  emitVaultLock();
  expect(broker?.list()).toHaveLength(0);
  expect(modelKeysVersion()).toBeGreaterThan(before);
  await expect(
    invokeWithModelKey(
      { token: key.token, clientId: "agent-1" },
      call,
      fence(),
    ),
  ).rejects.toMatchObject({ reason: "key.inactive" });

  activation.dispose();
  expect(activeModelKeyBroker()).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it("is bound by the provider runtime, so enabling External connectors is what makes a key possible", () => {
  const t = createTestContext();
  const activation = createActivation(t.ctx, "connectors.external");
  releases.push(activation.dispose);
  expect(activeModelKeyBroker()).toBeNull();
  bindProviderRuntime(t.ctx, activation);
  expect(activeModelKeyBroker()).not.toBeNull();
  activation.dispose();
  expect(activeModelKeyBroker()).toBeNull();
});
