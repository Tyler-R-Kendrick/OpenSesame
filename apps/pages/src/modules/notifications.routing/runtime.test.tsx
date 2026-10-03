/** @vitest-environment jsdom */
import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
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
const originalRemote = deviceIdentitySeams.remoteIdentityApi;

describe("notifications.routing runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    deviceIdentitySeams.remoteIdentityApi = originalRemote;
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("notifications.routing");
  });

  it("registers neither a category nor its walkthrough while no Identity API is named: the page would be one inbox row nobody can change, and the walkthrough navigates to it", async () => {
    deviceIdentitySeams.remoteIdentityApi = () => "";
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("settings-category")).toEqual([]);
    expect(t.entries("tutorial-target")).toEqual([]);
    expect(t.entries("tutorial-goal")).toEqual([]);
    expect(t.entries("tutorial-route")).toEqual([]);
    await handle.dispose();
  });

  it("registers the Notifications settings category and its walkthrough once a service is named", async () => {
    deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
    await expectLifecycle(runtimeOf(runtime), {
      capability: "notifications.routing",
      kinds: [
        "settings-category",
        "tutorial-target",
        "tutorial-goal",
        "tutorial-route",
      ],
      count: 4,
    });
  });

  it("follows the setting: the category arrives when a service is named and leaves when it is forgotten", async () => {
    let remote = "";
    deviceIdentitySeams.remoteIdentityApi = () => remote;
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("settings-category")).toHaveLength(0);
    remote = "https://id.example";
    saveSettings(loadSettings());
    expect(t.entries("settings-category")).toHaveLength(1);
    expect(t.entries("tutorial-goal")).toHaveLength(1);
    expect(t.entries("tutorial-route")).toHaveLength(1);
    remote = "";
    saveSettings(loadSettings());
    expect(t.entries("settings-category")).toHaveLength(0);
    expect(t.entries("tutorial-target")).toHaveLength(0);
    expect(t.entries("tutorial-goal")).toHaveLength(0);
    expect(t.entries("tutorial-route")).toHaveLength(0);
    await handle.dispose();
  });

  it("carries its files with the category, and reaches no network on activation", async () => {
    deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
    const fetcher = vi.spyOn(globalThis, "fetch");
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [category] = t.entries("settings-category");
    expect(category?.id).toBe("notifications");
    expect(category?.label).toBe("Notifications");
    expect(category?.guideId).toBe("settings.notifications");
    // No Identity session yet: nothing is listed, nothing asked.
    expect(category?.files?.list()).toEqual([]);
    await Promise.resolve();
    expect(t.egressCalls).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    await handle.dispose();
    await handle.dispose();
  });
});
