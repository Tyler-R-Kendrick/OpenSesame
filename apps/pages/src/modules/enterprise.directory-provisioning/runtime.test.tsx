/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enabledIdentityViews,
  resetIdentityViewsForTests,
} from "../../sections/identity/identity-views.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("enterprise.directory-provisioning runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetIdentityViewsForTests();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe(
      "enterprise.directory-provisioning",
    );
  });

  it("registers the directory tutorials and disposes them (LOAD-09)", async () => {
    const { targets, goals } = runtime.TUTORIAL;
    await expectLifecycle(runtimeOf(runtime), {
      capability: "enterprise.directory-provisioning",
      kinds: ["tutorial-goal", "tutorial-target"],
      count: targets.length + goals.length,
    });
  });

  it("puts the four Identity-API tabs on the page and takes them back", async () => {
    expect(enabledIdentityViews()).toEqual([]);
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    // The section's canonical order, not the order they were contributed in.
    expect(enabledIdentityViews()).toEqual([
      "people",
      "agents",
      "devices",
      "organization",
    ]);
    expect(t.entries("tutorial-target").map((d) => d.id)).toEqual([
      "identity.people",
      "identity.agents",
      "identity.devices",
      "identity.organization",
    ]);
    expect(t.entries("tutorial-goal").map((d) => d.id)).toEqual([
      "identity.users.manage",
      "identity.agents.manage",
      "identity.device.approve",
    ]);
    await handle.dispose();
    expect(enabledIdentityViews()).toEqual([]);
    await handle.dispose();
    expect(enabledIdentityViews()).toEqual([]);
  });
});
