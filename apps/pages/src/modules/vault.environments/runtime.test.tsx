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

describe("vault.environments runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers only the vaults settings panel", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "vault.environments",
      kinds: ["settings-panel"],
      count: 1,
    });
  });

  it("names the panel on the vaults category", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("settings-panel")).toEqual([
      expect.objectContaining({
        id: "vault-environments",
        label: "Environments",
        category: "vaults",
        order: 60,
      }),
    ]);
    await handle.dispose();
  });
});
