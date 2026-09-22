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

describe("notifications.web-push runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("notifications.web-push");
  });

  it("registers nothing on the document side: enrolment is a permission the person grants", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "notifications.web-push",
      kinds: [],
      count: 0,
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
});
