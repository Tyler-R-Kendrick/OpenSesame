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

describe("identity.siop runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("identity.siop");
  });

  it("registers the authorize route and disposes it (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "identity.siop",
      kinds: ["route", "tutorial-goal"],
      count: 1 + runtime.TUTORIAL.goals.length,
    });
  });

  it("serves /identity/siop behind the vault gate, framed", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(
      t.entries("route").map((r) => [r.id, r.path, r.framed, r.gate]),
    ).toEqual([["identity-siop", "/identity/siop", true, undefined]]);
    expect(t.entries("tutorial-goal").map((d) => d.id)).toEqual([
      "identity.local.siop.authorize",
    ]);
    expect(t.egressCalls).toEqual([]);
    await handle.dispose();
  });
});
