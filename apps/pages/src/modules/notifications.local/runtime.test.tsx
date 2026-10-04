/** @vitest-environment jsdom */
import { identityServes } from "@opensesame/app-core/lib/identity-plane.js";
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

describe("notifications.local runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM, storage or permission side effect", async () => {
    const request = vi.fn();
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: request,
    });
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(request).not.toHaveBeenCalled();
    expect(runtime.capabilityRuntime.capability).toBe("notifications.local");
    vi.unstubAllGlobals();
  });

  it("registers its panel, its watcher and its walkthrough, and disposes them (LOAD-09)", async () => {
    const { targets, goals } = runtime.TUTORIAL;
    await expectLifecycle(runtimeOf(runtime), {
      capability: "notifications.local",
      kinds: [
        "settings-panel",
        "tutorial-goal",
        "tutorial-target",
        "unlock-effect",
      ],
      count: 1 + 1 + targets.length + goals.length,
    });
  });

  it("draws its panel inside its own Capabilities section, with its file", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [panel] = t.entries("settings-panel");
    expect(panel?.category).toBe("capabilities.feature-local-notifications");
    expect(panel?.files?.list().map((file) => file.path)).toEqual([
      "settings/capabilities/local-notifications.json",
    ]);
    await handle.dispose();
  });

  it("serves the device's notifications family while it is on, and not after", async () => {
    expect(identityServes("notifications")).toBe(false);
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(identityServes("notifications")).toBe(true);
    await handle.dispose();
    expect(identityServes("notifications")).toBe(false);
  });

  it("reaches no network and asks for no permission on activation", async () => {
    const request = vi.fn();
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: request,
    });
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.egressCalls).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    await handle.dispose();
    vi.unstubAllGlobals();
  });

  it("starts a watcher per unlock that stops, and takes its marks down, with its signal", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [effect] = t.entries("unlock-effect");
    const controller = new AbortController();
    const running = effect?.run({
      tomb: "no-such-tomb",
      guest: false,
      signal: controller.signal,
    });
    // The inbox of a tomb that is not open cannot be read, so nothing is
    // marked; stopping it resolves and leaves the page as it found it.
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    await handle.dispose();
  });
});
