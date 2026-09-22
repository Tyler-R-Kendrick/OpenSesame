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

describe("sharing.drops runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers the claim route and the drop item kind (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "sharing.drops",
      kinds: ["item-kind", "route"],
      count: 2,
    });
  });

  it("serves /claim outside the unlock gate, unframed", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("route").map((r) => [r.id, r.path, r.framed, r.gate])).toEqual([
      ["claim", "/claim", false, "any"],
    ]);
    expect(t.entries("item-kind").map((k) => [k.kind, k.label, k.segment, k.order])).toEqual(
      [["drop", "Drops", "drops", 50]],
    );
    await handle.dispose();
  });
});
