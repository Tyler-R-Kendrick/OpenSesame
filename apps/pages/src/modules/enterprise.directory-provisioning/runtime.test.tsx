/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentDirectoryPanels } from "../../sections/identity/directory-panel-slot.js";
import { DIRECTORY_PANELS } from "../../sections/identity/directory-panels.js";
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
      kinds: ["command-path", "tutorial-goal", "tutorial-target"],
      // 4 tab commands + tutorial descriptors
      count: 4 + targets.length + goals.length,
    });
  });

  it("hands the Identity section its panels and takes them back", async () => {
    // The section is always on and never imports these (ADR 0140).
    expect(currentDirectoryPanels()).toBeNull();
    const handle = await runtime.capabilityRuntime.activate(
      createTestContext().ctx,
    );
    expect(currentDirectoryPanels()).toBe(DIRECTORY_PANELS);
    await handle.dispose();
    expect(currentDirectoryPanels()).toBeNull();
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
    // Each tab is a destination for as long as this capability draws it; with
    // the Identity API excluded, `/identity?view=devices` is nowhere to go.
    expect(t.entries("command-path")).toEqual([
      { path: "/identity?view=people", label: "Identity · People" },
      { path: "/identity?view=agents", label: "Identity · Agents" },
      { path: "/identity?view=devices", label: "Identity · Devices" },
      {
        path: "/identity?view=organization",
        label: "Identity · Organizations",
      },
    ]);
    // Devices is drawn by the section host too, and a target is declared
    // once: the button's id comes from `identity.local-iam`.
    expect(t.entries("tutorial-target").map((d) => d.id)).toEqual([
      "identity.people",
      "identity.agents",
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
