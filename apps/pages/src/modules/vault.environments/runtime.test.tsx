/** @vitest-environment jsdom */
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

afterEach(cleanup);

describe("vault.environments runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("adds the Environment item kind and no vault key, route, notice job or settings panel", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "vault.environments",
      kinds: ["item-kind"],
      count: 1,
    });
  });

  it("registers the kind the type picker and vault rail read", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("item-kind")).toEqual([
      {
        kind: "environment",
        label: "Environments",
        segment: "environments",
        order: 80,
      },
    ]);
    expect(t.entries("vault-command")).toEqual([]);
    expect(t.entries("background-job")).toEqual([]);
    expect(t.entries("route")).toEqual([]);
    expect(t.entries("command-path")).toEqual([]);
    expect(t.entries("settings-panel")).toEqual([]);
    await handle.dispose();
  });
});
