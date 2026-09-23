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

describe("backup.git-remote runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers only the observer job (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "backup.git-remote",
      kinds: ["background-job"],
      count: 1,
    });
  });

  it("adds no settings category: Capabilities draws the Backups tiles", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("settings-category")).toEqual([]);
    expect(t.hydrated).toEqual([]);
    expect(t.egressCalls).toEqual([]);
    await handle.dispose();
  });

  it("runs the backup observer only while active, and starts nothing on activate", async () => {
    const observer = await import(
      "@opensesame/app-core/lib/vault-backup-observer.js"
    );
    const interval = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);

    // Registering the job does not start it: the core decides when.
    const [job] = t.entries("background-job");
    expect(job?.id).toBe("vault-backup-observer");
    expect(interval).not.toHaveBeenCalled();

    const jobs = new AbortController();
    job?.start(jobs.signal);
    expect(interval).toHaveBeenCalledTimes(1);

    // The job's own signal stops it without anyone disposing the module.
    jobs.abort("plan change");
    expect(clear).toHaveBeenCalledTimes(1);

    // Disposal is idempotent and never re-starts anything.
    await handle.dispose();
    await handle.dispose();
    expect(interval).toHaveBeenCalledTimes(1);
    observer.stopVaultBackupObserver();
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
