/** @vitest-environment jsdom */
import {
  MODEL_TEST_SECRET,
  modelMemoryBackend,
  saveModelFixture,
} from "@opensesame/app-core/lib/hosted-model.test-support.js";
import {
  modelProviderRecord,
  modelProviderSeams,
} from "@opensesame/app-core/lib/model-provider.js";
import { bindNativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { resetAgUiEndpointForTest } from "@opensesame/app-core/tutorial/agents/ag-ui/endpoint.js";
import { fakeSupportPageContext } from "@opensesame/support-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSupportAgentLoadersForTest,
  supportAgentLoaders,
} from "../../tutorial/agent-seams.js";
import { createActivation } from "../activation.js";
import { bindNativeModelRuntime } from "../connectors.external/native-model-runtime.js";
import { createTestContext } from "../test-context.js";
import { acceptedRemoteModels, capabilityRuntime } from "./runtime.js";
const originalModels = { ...modelProviderSeams };
let releaseConnector = () => {};
beforeEach(() => {
  modelMemoryBackend(false);
  modelProviderSeams.loadModelProvider = () =>
    modelProviderRecord({
      kind: "hosted",
      provider: "openai",
      endpoint: "https://ignored.example",
      model: "gpt-4o",
    });
  resetAgUiEndpointForTest();
});
afterEach(() => {
  releaseConnector();
  Object.assign(modelProviderSeams, originalModels);
  resetSupportAgentLoadersForTest();
  resetAgUiEndpointForTest();
  vi.restoreAllMocks();
});
const request = {
  question: "Where is lock?",
  history: [],
  context: fakeSupportPageContext(),
};
describe("native saved-model support lifecycle", () => {
  it("answers the actual question under both active capabilities without inference at activation", async () => {
    await saveModelFixture("openai");
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        choices: [{ message: { content: "Click Lock in the sidebar." } }],
      }),
    );
    const releaseTransport = bindNativeProviderTransport({
      fetch,
      assertCurrent() {},
    });
    const activation = createActivation(
      createTestContext().ctx,
      "connectors.external",
    );
    bindNativeModelRuntime(activation);
    releaseConnector = () => {
      activation.dispose();
      releaseTransport();
    };
    const t = createTestContext();
    const handle = await capabilityRuntime.activate(t.ctx);
    expect(fetch).not.toHaveBeenCalled();
    expect(acceptedRemoteModels()).toEqual([]);
    const module = await supportAgentLoaders.agUi();
    const agent = module.createAgUiAgent();
    expect(agent).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const turn = await agent?.run(request, {
      signal: new AbortController().signal,
    });
    expect(turn?.answer).toBe("Click Lock in the sidebar.");
    const body = String(fetch.mock.calls[0]?.[1]?.body);
    expect(body).toContain("Where is lock?");
    expect(body).not.toContain(MODEL_TEST_SECRET);
    await handle.dispose();
    await expect(
      agent?.run(request, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "AGENT_ABORTED" });
  });
  it("does not acquire a model transport when External connectors is unavailable", async () => {
    await saveModelFixture("openai");
    const t = createTestContext();
    const handle = await capabilityRuntime.activate(t.ctx);
    const module = await supportAgentLoaders.agUi();
    expect(module.createAgUiAgent()).toBeNull();
    await handle.dispose();
  });
  it("refuses a retained factory after manual disposal even while the lease signal has not aborted", async () => {
    await saveModelFixture("openai");
    const releaseTransport = bindNativeProviderTransport({
      fetch: vi.fn<typeof globalThis.fetch>(),
      assertCurrent() {},
    });
    const activation = createActivation(
      createTestContext().ctx,
      "connectors.external",
    );
    bindNativeModelRuntime(activation);
    releaseConnector = () => {
      activation.dispose();
      releaseTransport();
    };
    const t = createTestContext();
    const handle = await capabilityRuntime.activate(t.ctx);
    const pending = supportAgentLoaders.agUi();
    await handle.dispose();
    const module = await pending;
    expect(module.createAgUiAgent()).toBeNull();
  });
});
