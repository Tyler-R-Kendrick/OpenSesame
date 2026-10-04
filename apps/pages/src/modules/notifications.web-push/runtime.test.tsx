/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { pushSeams } from "../../lib/push.js";
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

  it("registers one settings panel, the enrolment row; the permission is the person's to grant", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "notifications.web-push",
      kinds: ["settings-panel"],
      count: 1,
    });
  });

  it("reaches no network on activation, reads only its own key, and routes enrolment through the egress port until it is disposed", async () => {
    const direct = pushSeams.fetchFn;
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.egressCalls).toEqual([]);
    expect(t.hydrated).toEqual([["push.subscription.id"]]);
    expect(pushSeams.fetchFn).not.toBe(direct);
    const [panel] = t.entries("settings-panel");
    expect(panel?.category).toBe("general");
    await handle.dispose();
    await handle.dispose();
    expect(pushSeams.fetchFn).toBe(direct);
  });
});
