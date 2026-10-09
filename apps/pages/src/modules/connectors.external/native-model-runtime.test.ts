import { performHostedInference } from "@opensesame/app-core/lib/hosted-inference.js";
import { hostedModelAuthority } from "@opensesame/app-core/lib/hosted-model-authority.js";
import {
  modelMemoryBackend,
  saveModelFixture,
} from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindNativeModelRuntime } from "./native-model-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
  vi.restoreAllMocks();
});
function activate(answer: string) {
  const t = createTestContext();
  const fetcher = vi.fn<typeof t.ctx.egress.fetch>(async () =>
    Response.json({ choices: [{ message: { content: answer } }] }),
  );
  const ctx = { ...t.ctx, egress: { ...t.ctx.egress, fetch: fetcher } };
  const activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  bindNativeModelRuntime(activation);
  releases.push(activation.dispose);
  return { activation, fetcher };
}
it("uses captured connector egress rather than a caller-provided fetch and clears authority on disposal", async () => {
  modelMemoryBackend(false);
  await saveModelFixture("openai");
  const { activation, fetcher } = activate("Actual provider answer");
  const injected = vi.fn<typeof fetch>();
  const result = await performHostedInference(
    "openai",
    {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Where is Lock?" }],
      maxOutputTokens: 100,
    },
    {
      fetch: injected,
      assertCurrent() {},
      signal: new AbortController().signal,
    },
  );
  expect(result.answer).toBe("Actual provider answer");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(injected).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[0]?.[2]?.capability).toBe("connectors.external");
  const captured = hostedModelAuthority();
  expect(captured).not.toBeNull();
  activation.dispose();
  expect(hostedModelAuthority()).toBeNull();
  expect(() => captured?.assertCurrent()).toThrow();
});
it("an older activation cannot remove a newer model authority", async () => {
  modelMemoryBackend(false);
  await saveModelFixture("openai");
  const first = activate("First answer");
  const second = activate("Second answer");
  const current = hostedModelAuthority();
  first.activation.dispose();
  expect(hostedModelAuthority()).toBe(current);
  expect(current?.connections()).toEqual([
    expect.objectContaining({ providerId: "openai", status: "connected" }),
  ]);
  second.activation.dispose();
  expect(hostedModelAuthority()).toBeNull();
});
