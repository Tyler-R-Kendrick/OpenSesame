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

describe("sharing.trusted-contacts runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe(
      "sharing.trusted-contacts",
    );
  });

  it("registers the Trusted contacts Security panel and its walkthrough, and disposes them (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "sharing.trusted-contacts",
      kinds: [
        "settings-panel",
        "tutorial-goal",
        "tutorial-route",
        "tutorial-target",
      ],
      count:
        1 +
        runtime.TUTORIAL.targets.length +
        runtime.TUTORIAL.goals.length +
        runtime.TUTORIAL.routes.length,
    });
  });

  it("draws one panel inside Security, with no settings file and no network", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [panel] = t.entries("settings-panel");
    expect(panel?.id).toBe("trusted-contacts");
    expect(panel?.label).toBe("Trusted contacts");
    expect(panel?.category).toBe("security");
    expect(panel?.order).toBe(330);
    expect(panel?.files).toBeUndefined();
    expect(t.entries("settings-category")).toEqual([]);
    expect(t.egressCalls).toEqual([]);
    await handle.dispose();
  });
});
