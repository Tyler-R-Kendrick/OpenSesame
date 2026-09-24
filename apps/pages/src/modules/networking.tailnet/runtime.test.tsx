/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("networking.tailnet runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("networking.tailnet");
  });

  it("registers only the tailnet sync job", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "networking.tailnet",
      kinds: ["background-job"],
      count: 1,
    });
  });

  it("reaches no network on activation", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.egressCalls).toEqual([]);
    expect(t.hydrated).toEqual([]);
    await handle.dispose();
    await handle.dispose();
  });

  it("runs the sync observer only while its job runs", async () => {
    const observer = await import(
      "@opensesame/app-core/lib/tailnet-sync/observer.js"
    );
    const interval = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const fetcher = vi.spyOn(globalThis, "fetch");
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);

    const [job] = t.entries("background-job");
    expect(job?.id).toBe("tailnet-vault-sync");
    expect(interval).not.toHaveBeenCalled();

    const jobs = new AbortController();
    job?.start(jobs.signal);
    expect(interval).toHaveBeenCalledTimes(1);
    // No vault is paired, so the job has nobody to talk to.
    expect(fetcher).not.toHaveBeenCalled();

    jobs.abort("plan change");
    expect(clear).toHaveBeenCalledTimes(1);
    expect(observer.tailnetSyncState().phase).toBe("off");

    await handle.dispose();
    await handle.dispose();
    expect(interval).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when the job signal is already aborted", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [job] = t.entries("background-job");
    const stale = new AbortController();
    stale.abort("superseded");
    job?.start(stale.signal);
    expect(interval).not.toHaveBeenCalled();
    await handle.dispose();
  });
});
