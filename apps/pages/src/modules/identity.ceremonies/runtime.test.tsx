/** @vitest-environment jsdom */
import { devicePath } from "@opensesame/app-core/lib/device-link.js";
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

describe("identity.ceremonies runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers the device route and nothing else (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "identity.ceremonies",
      kinds: ["route"],
      count: 1,
    });
  });

  it("serves /device behind unlock, at the spec's path", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(
      t.entries("route").map((r) => [r.id, r.path, r.framed, r.gate]),
    ).toEqual([["device", "/device", true, undefined]]);
    // `spec/config/ceremony-routes.json` names the path once (ADR 0139); the
    // literal above is what the registry parity sweep reads.
    expect(t.entries("route")[0]?.path).toBe(devicePath("/"));
    await handle.dispose();
  });
});
