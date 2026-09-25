/** @vitest-environment jsdom */
import { claimPath } from "@opensesame/app-core/lib/claims/arrival.js";
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

  it("registers the device and claim routes and nothing else (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "identity.ceremonies",
      kinds: ["route"],
      count: 2,
    });
  });

  it("serves /device and /claim before unlock, at the spec's paths", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(
      t.entries("route").map((r) => [r.id, r.path, r.framed, r.gate]),
    ).toEqual([
      ["device", "/device", true, "any"],
      ["claim", "/claim", true, "any"],
    ]);
    // `spec/config/ceremony-routes.json` names each path once (ADR 0139); the
    // literals above are what the registry parity sweep reads.
    expect(t.entries("route").map((r) => r.path)).toEqual([
      devicePath("/"),
      claimPath("/"),
    ]);
    await handle.dispose();
  });
});
