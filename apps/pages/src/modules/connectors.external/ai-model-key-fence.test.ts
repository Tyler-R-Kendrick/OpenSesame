import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { saveAiConnection } from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { bindAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import { hostedModelAuthority } from "@opensesame/app-core/lib/hosted-model-authority.js";
import { bindNativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { connectionFacts } from "./native-model-keys-runtime.js";
import { bindNativeModelRuntime } from "./native-model-runtime.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
const releases: (() => void)[] = [];
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  while (releases.length) releases.pop()?.();
  await fixture.close();
});

it.each(["openai_chat", "openai_responses"] as const)(
  "does not lend a saved custom %s vault token to the compiled vendor broker",
  async (family) => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/responses")
        ? Response.json({
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "OK" }],
              },
            ],
          })
        : Response.json({ choices: [{ message: { content: "OK" } }] }),
    );
    const lifetime = new AbortController();
    const transport = {
      fetch: fetcher,
      assertCurrent: vi.fn(),
      signal: lifetime.signal,
    };
    releases.push(bindAiConnectionTransport(transport));
    releases.push(bindNativeProviderTransport(transport));
    const ctx = createTestContext().ctx;
    const activation = createActivation(ctx, "connectors.external");
    bindNativeModelRuntime(activation);
    releases.push(activation.dispose);
    const saved = await saveAiConnection({
      ...aiConnectionDraft("openai"),
      family,
      baseUrl: "https://custom-ai.example/mounted/v1",
      model: "fixture-model",
      apiKey: "vault-bound-private-token",
    });
    expect(saved.status).toBe("connected");
    expect(connectionFacts(saved.connectionId)).toBeNull();
    fetcher.mockClear();
    const authority = hostedModelAuthority();
    if (!authority) throw new Error("Missing captured model authority");
    await expect(async () =>
      authority.execute(
        saved.connectionId,
        {
          providerId: "openai",
          operationId: "model.inference",
          method: "POST",
          origin: "https://api.openai.com",
          path: "/v1/chat/completions",
        },
        {
          model: "fixture-model",
          messages: [{ role: "user", content: "forbidden delegation" }],
        },
        (body) => body,
        transport,
      ),
    ).rejects.toThrow(/delegat|canonical|protocol|configured/i);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
