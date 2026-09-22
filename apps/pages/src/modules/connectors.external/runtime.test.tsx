/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectCallbackBase } from "../../lib/connect-callback.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { LeaseAbortedError } from "../signals.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";
import type * as Effects from "./unlock-effects.js";

let runtime: typeof Runtime;
let effects: typeof Effects;

const KINDS = [
  "command-path",
  "keymap-jump",
  "route",
  "section",
  "settings-category",
  "setup-panel",
  "tutorial-goal",
  "tutorial-route",
  "tutorial-target",
  "unlock-effect",
];
// 1 section + 2 routes + 1 settings + 1 setup + 1 command + 1 jump
// + 15 targets + 2 goals + 1 route + 2 unlock effects
const COUNT = 1 + 2 + 1 + 1 + 1 + 1 + 15 + 2 + 1 + 2;

describe("connectors.external runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    effects = await import("./unlock-effects.js");
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("connectors.external");
  });

  it("registers exactly the connections contributions and disposes them (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "connectors.external",
      kinds: KINDS,
      count: COUNT,
    });
  });

  it("names the section, routes, settings, setup and jump entries exactly", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("section").map((s) => [s.id, s.to, s.jump, s.icon, s.order]))
      .toEqual([["connections", "/connections", "c", "connection", 20]]);
    expect(t.entries("section")[0]?.Tree).toBeTypeOf("function");
    expect(t.entries("route").map((r) => [r.id, r.path, r.framed])).toEqual([
      ["connections", "/connections/:providerId?/:connectionId?", true],
      ["settings-connections", "/settings/connections/:providerId/:connectionId?", true],
    ]);
    expect(t.entries("settings-category").map((c) => [c.id, c.guideId])).toEqual([
      ["connections", "settings.connections"],
    ]);
    expect(t.entries("setup-panel").map((p) => [p.id, p.tab, p.rail, p.order])).toEqual([
      ["connectors", "connectors", "Connectors", 10],
    ]);
    expect(t.entries("command-path")).toEqual([
      { path: "/connections", label: "Connections" },
    ]);
    expect(t.entries("keymap-jump")).toEqual([{ key: "c", path: "/connections" }]);
    expect(t.entries("tutorial-target").map((d) => d.id)).toEqual([
      ...runtime.TUTORIAL.targets,
    ]);
    expect(t.entries("tutorial-goal").map((d) => d.id)).toEqual([
      ...runtime.TUTORIAL.goals,
    ]);
    expect(t.entries("tutorial-route").map((d) => d.id)).toEqual(["/connections"]);
    expect(t.entries("unlock-effect").map((e) => e.id)).toEqual([
      "seal-connector-directory",
      "hydrate-vercel-connect",
    ]);
    await handle.dispose();
  });

  it("hydrates its own keys and applies the Connect callback base from runtime config", async () => {
    const t = createTestContext({
      runtimeConfig: {
        endpoints: { connectCallbackBase: "https://relay.example.test" },
      },
    });
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.hydrated).toEqual([[...runtime.HYDRATE_KEYS]]);
    expect(runtime.HYDRATE_KEYS).toContain("connector-directory.v1");
    expect(runtime.HYDRATE_KEYS).toContain("connections.firstRun.v1");
    expect(connectCallbackBase()).toBe("https://relay.example.test");
    await handle.dispose();
    expect(connectCallbackBase()).toBe("");
  });

  it("registers nothing when the lease aborts while it hydrates", async () => {
    const t = createTestContext();
    const slowHydrate = new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    const ctx = { ...t.ctx, hydrate: () => slowHydrate };
    const pending = runtime.capabilityRuntime.activate(ctx);
    t.abort("lock");
    const handle = await pending;
    expect(t.registered).toHaveLength(0);
    await handle.dispose();
  });

  it("runs unlock effects only through activate, fenced by the lease (S12-F)", async () => {
    const seal = vi.fn(async () => true);
    const hydrate = vi.fn(async () => true);
    const original = { ...effects.connectorUnlockSeams };
    Object.assign(effects.connectorUnlockSeams, {
      sealPendingConnectorDirectory: seal,
      hydrateVercelConnectAuth: hydrate,
    });
    try {
      // Nothing runs on import or on activate itself.
      const t = createTestContext({ tomb: "personal" });
      const handle = await runtime.capabilityRuntime.activate(t.ctx);
      expect(seal).not.toHaveBeenCalled();
      expect(hydrate).not.toHaveBeenCalled();

      // The core invokes the effect with the tomb; it runs once, as before.
      const [sealEffect, hydrateEffect] = t.entries("unlock-effect");
      const effectSignal = new AbortController().signal;
      await sealEffect?.run({ tomb: "personal", guest: true, signal: effectSignal });
      await hydrateEffect?.run({ tomb: "personal", guest: false, signal: effectSignal });
      expect(seal).toHaveBeenCalledWith("personal", { ephemeral: true });
      expect(hydrate).toHaveBeenCalledWith("personal", { ephemeral: false });

      // Disable mid-flight: a pending effect settles as aborted, and its
      // late result has no owner.
      let finish: (() => void) | undefined;
      hydrate.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = () => resolve(true);
          }),
      );
      const inFlight = hydrateEffect?.run({
        tomb: "personal",
        guest: false,
        signal: effectSignal,
      });
      t.abort("disable");
      await expect(inFlight).rejects.toBeInstanceOf(LeaseAbortedError);
      finish?.();
      expect(t.live()).toHaveLength(0);

      // After the abort nothing starts: the seam is not even called.
      seal.mockClear();
      await expect(
        sealEffect?.run({ tomb: "personal", guest: false, signal: effectSignal }),
      ).rejects.toBeInstanceOf(LeaseAbortedError);
      expect(seal).not.toHaveBeenCalled();
      await handle.dispose();
    } finally {
      Object.assign(effects.connectorUnlockSeams, original);
    }
  });

  it("stops an effect when its own signal aborts, even with a live lease", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [sealEffect] = t.entries("unlock-effect");
    const own = new AbortController();
    own.abort();
    await expect(
      sealEffect?.run({ tomb: "personal", guest: false, signal: own.signal }),
    ).rejects.toBeInstanceOf(LeaseAbortedError);
    await handle.dispose();
  });
});
