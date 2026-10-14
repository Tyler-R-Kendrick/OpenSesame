/** @vitest-environment jsdom */
import { kvDelete, kvSetDurable } from "@opensesame/app-core/lib/kv.js";
import {
  MODEL_PROVIDER_KEY,
  loadModelProvider,
} from "@opensesame/app-core/lib/model-provider.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetSupportAgentLoadersForTest,
  supportAgentLoaders,
} from "../../tutorial/agent-seams.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("support.local-ai runtime", () => {
  afterEach(() => {
    kvDelete(MODEL_PROVIDER_KEY);
    vi.restoreAllMocks();
    resetSupportAgentLoadersForTest();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("support.local-ai");
  });

  it("registers the AI setup tab, the settings tool and its assists (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "support.local-ai",
      kinds: [
        "command-assist",
        "item-draft-assist",
        "settings-panel",
        "setup-panel",
        "webmcp-tool",
      ],
      count: 5,
    });
  });

  it("owns the command bar's model and voice, draft suggestions and the model picker", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [assist] = t.entries("command-assist");
    expect(assist?.interpret).toBeTypeOf("function");
    expect(assist?.Voice).toBeTypeOf("function");
    expect(t.entries("item-draft-assist").map((a) => a.id)).toEqual([
      "on-device",
    ]);
    expect(t.entries("settings-panel").map((p) => [p.id, p.category])).toEqual([
      ["model-provider", "features.feature-ai"],
    ]);
    await handle.dispose();
  });

  it("names the setup tab and the tool exactly", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(
      t.entries("setup-panel").map((p) => [p.id, p.tab, p.rail, p.order]),
    ).toEqual([["ai", "ai", "AI", 20]]);
    expect(t.entries("webmcp-tool").map((tool) => tool.name)).toEqual([
      "opensesame_settings_read",
    ]);
    await handle.dispose();
  });

  it("hydrates saved native model and voice choices before exposing their consumers", async () => {
    const t = createTestContext();
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const inference = {
      kind: "hosted",
      provider: "byo-ai",
      endpoint: "https://models.example/custom/v1",
      model: "custom-chat",
      connectionId: "native-ai-saved",
    };
    const voice = {
      kind: "browser",
      provider: "browser-speech",
      endpoint: "",
      model: "ja-JP",
    };
    const hydrate = vi.fn(async (keys: readonly string[]) => {
      expect(keys).toEqual([MODEL_PROVIDER_KEY]);
      await pending;
      await kvSetDurable(
        MODEL_PROVIDER_KEY,
        JSON.stringify({ ...inference, inference, voice }),
      );
    });
    const activating = runtime.capabilityRuntime.activate({
      ...t.ctx,
      hydrate,
    });
    expect(t.live()).toHaveLength(0);
    expect(hydrate).toHaveBeenCalledOnce();
    finish();
    const handle = await activating;
    expect(t.entries("settings-panel")).toHaveLength(1);
    expect(loadModelProvider().inference).toEqual(inference);
    expect(loadModelProvider().voice).toEqual(voice);
    await handle.dispose();
  });

  it("installs nothing if the lease ends while preferences hydrate", async () => {
    const t = createTestContext();
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const activating = runtime.capabilityRuntime.activate({
      ...t.ctx,
      hydrate: () => pending,
    });
    t.abort("vault locked");
    finish();
    const handle = await activating;
    expect(t.registered).toHaveLength(0);
    await handle.dispose();
  });

  it("installs the on-device loader only while active, and loads nothing", async () => {
    const absent = supportAgentLoaders.promptApi;
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(supportAgentLoaders.promptApi).not.toBe(absent);
    // Installing a loader is assigning a function: the adapter is fetched
    // when the panel asks, never on activation.
    expect((await absent()).createPromptApiAgent()).toBeNull();

    await handle.dispose();
    expect(supportAgentLoaders.promptApi).toBe(absent);
    const restored = await supportAgentLoaders.promptApi();
    expect(restored.createPromptApiAgent()).toBeNull();
    await handle.dispose();
    expect(supportAgentLoaders.promptApi).toBe(absent);
  });
});
