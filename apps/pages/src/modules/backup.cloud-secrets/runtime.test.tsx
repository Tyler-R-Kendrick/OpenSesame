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

  it("registers only the Cloud secrets settings category (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "backup.cloud-secrets",
      kinds: ["settings-category"],
      count: 1,
    });
  });

  it("names the category exactly and touches no KMS protector", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(
      t.entries("settings-category").map((c) => [c.id, c.label, c.guideId, c.order]),
    ).toEqual([["cloud-secrets", "Cloud secrets", "settings.backup", 46]]);
    expect(t.egressCalls).toEqual([]);
    await handle.dispose();
  });
});
