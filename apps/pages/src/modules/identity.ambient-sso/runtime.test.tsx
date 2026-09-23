import {
  deployedAmbientPolicy,
  resetDeployedAmbientPolicy,
} from "@opensesame/app-core/lib/ambient-auth/runtime.js";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextWithPorts } from "../ports-b.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("identity.ambient-sso runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetDeployedAmbientPolicy();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("identity.ambient-sso");
  });

  it("registers the boot job and disposes it (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "identity.ambient-sso",
      kinds: ["background-job", "settings-panel"],
      count: 2,
    });
  });

  it("does not evaluate the boot until the job is started", async () => {
    runtime.resetAmbientBootForTest();
    const run = vi.fn();
    const original = runtime.ambientRuntimeSeams.runAmbientAuthBoot;
    runtime.ambientRuntimeSeams.runAmbientAuthBoot = run;
    try {
      const t = createTestContext();
      const handle = await runtime.capabilityRuntime.activate(t.ctx);
      const [job] = t.entries("background-job");
      expect(job?.id).toBe("ambient-auth-boot");
      expect(run).not.toHaveBeenCalled();

      job?.start(new AbortController().signal);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toMatchObject({ hasAuthCallback: false });

      // An aborted lease reaches no provider at all.
      run.mockClear();
      const aborted = new AbortController();
      aborted.abort("disabled");
      job?.start(aborted.signal);
      expect(run).not.toHaveBeenCalled();
      await handle.dispose();
    } finally {
      runtime.ambientRuntimeSeams.runAmbientAuthBoot = original;
    }
  });

  it("boots once per document, however often the plan re-activates it", async () => {
    runtime.resetAmbientBootForTest();
    const run = vi.fn();
    const original = runtime.ambientRuntimeSeams.runAmbientAuthBoot;
    runtime.ambientRuntimeSeams.runAmbientAuthBoot = run;
    try {
      for (let generation = 0; generation < 3; generation += 1) {
        const t = createTestContext();
        const handle = await runtime.capabilityRuntime.activate(t.ctx);
        t.entries("background-job")[0]?.start(new AbortController().signal);
        await handle.dispose();
      }
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      runtime.ambientRuntimeSeams.runAmbientAuthBoot = original;
    }
  });

  it("applies the deployment policy only while active", async () => {
    expect(deployedAmbientPolicy()).toBeUndefined();
    const t = createTestContext({
      runtimeConfig: { ambientAuth: { mode: "returning-user" } },
    });
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(deployedAmbientPolicy()).toEqual({ mode: "returning-user" });
    await handle.dispose();
    expect(deployedAmbientPolicy()).toBeUndefined();
    await handle.dispose();
    expect(deployedAmbientPolicy()).toBeUndefined();
  });

  it("contributes the Security panel and revokes it on dispose", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const panel = t.registered.find((r) => r.kind === "settings-panel");
    expect(panel?.entry).toMatchObject({
      id: "ambient-auth",
      category: "security",
    });
    expect(panel?.revoked).toBe(false);
    await handle.dispose();
    expect(panel?.revoked).toBe(true);
    await handle.dispose();
    expect(panel?.revoked).toBe(true);
  });
});
