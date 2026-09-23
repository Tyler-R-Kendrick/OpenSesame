/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("backup.cloud-secrets runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers nothing: Settings › Capabilities draws its tiles (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "backup.cloud-secrets",
      kinds: [],
      count: 0,
    });
  });

  it("touches no KMS protector and reaches no network", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.egressCalls).toEqual([]);
    expect(t.hydrated).toEqual([]);
    await handle.dispose();
  });
});
