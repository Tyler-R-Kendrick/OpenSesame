import {
  currentAgUiEndpoint,
  resetAgUiEndpointForTest,
} from "@opensesame/app-core/tutorial/agents/ag-ui/endpoint.js";
/** @vitest-environment jsdom */
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
import { resetAcceptedRemoteModelsForTest } from "./runtime.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("support.remote-ai runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetSupportAgentLoadersForTest();
    resetAgUiEndpointForTest();
    resetAcceptedRemoteModelsForTest();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("support.remote-ai");
  });

  it("registers the endpoint job and disposes it (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "support.remote-ai",
      kinds: ["background-job", "command-assist"],
      count: 2,
    });
  });

  it("reads no deploy config until the job is started", async () => {
    const load = vi.fn(async () => null);
    const original = runtime.remoteSupportSeams.loadAgUiEndpoint;
    runtime.remoteSupportSeams.loadAgUiEndpoint = load;
    try {
      const t = createTestContext();
      const handle = await runtime.capabilityRuntime.activate(t.ctx);
      const [job] = t.entries("background-job");
      expect(job?.id).toBe("ag-ui-endpoint");
      expect(load).not.toHaveBeenCalled();

      job?.start(new AbortController().signal);
      expect(load).toHaveBeenCalledTimes(1);

      // A lease that already aborted reaches no endpoint at all.
      load.mockClear();
      const aborted = new AbortController();
      aborted.abort("disabled");
      job?.start(aborted.signal);
      expect(load).not.toHaveBeenCalled();
      await handle.dispose();
    } finally {
      runtime.remoteSupportSeams.loadAgUiEndpoint = original;
    }
  });

  it("loads saved models only through the lease egress port", async () => {
    const raw = vi.spyOn(globalThis, "fetch");
    const original = runtime.remoteSupportSeams.loadAgUiEndpoint;
    runtime.remoteSupportSeams.loadAgUiEndpoint = async () => null;
    try {
      const t = createTestContext();
      const signal = new AbortController().signal;
      runtime.startAgUiEndpointLoad(signal, t.ctx.egress);
      expect(raw).not.toHaveBeenCalled();
      expect(t.egressCalls).toEqual([]);
    } finally {
      runtime.remoteSupportSeams.loadAgUiEndpoint = original;
    }
  });

  it("installs both remote loaders only while active", async () => {
    const absentProvider = supportAgentLoaders.provider;
    const absentAgUi = supportAgentLoaders.agUi;
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(supportAgentLoaders.provider).not.toBe(absentProvider);
    expect(supportAgentLoaders.agUi).not.toBe(absentAgUi);

    await handle.dispose();
    expect(supportAgentLoaders.provider).toBe(absentProvider);
    expect(supportAgentLoaders.agUi).toBe(absentAgUi);
    expect(currentAgUiEndpoint()).toBeNull();
    await handle.dispose();
    expect(supportAgentLoaders.agUi).toBe(absentAgUi);
  });
});
