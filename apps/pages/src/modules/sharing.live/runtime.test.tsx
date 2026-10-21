/** @vitest-environment jsdom */
import { CarrierBlocked } from "@opensesame/app-core/lib/live/rendezvous.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import { CARRIER_PURPOSE } from "./carriers/allowed.js";
import { carriersUnavailable } from "./carriers/index.js";
import { liveUiSeams } from "./live-hooks.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("sharing.live runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("sharing.live");
  });

  it("registers the join route, the Share key's shell wrapper and its guide target — and no settings tab", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "sharing.live",
      kinds: ["route", "shell-wrapper", "tutorial-target", "tutorial-goal"],
      count: 4,
    });
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("settings-category")).toEqual([]);
    const [wrapper] = t.entries("shell-wrapper");
    expect(wrapper?.id).toBe("live-share");
    const [target] = t.entries("tutorial-target");
    expect(target?.id).toBe("shell.share");
    await handle.dispose();
  });

  it("serves the join screen on a locked device, and opens no socket on activation", async () => {
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [route] = t.entries("route");
    expect(route?.path).toBe("/live");
    expect(route?.gate).toBe("any");
    expect(t.egressCalls).toEqual([]);
    expect(socket).not.toHaveBeenCalled();
    await handle.dispose();
    await handle.dispose();
    vi.unstubAllGlobals();
  });

  it("hands carriers this activation's egress port, and takes them away on dispose", async () => {
    const startedAt = 1_700_000_000_123;
    vi.spyOn(Date, "now").mockReturnValue(startedAt);
    expect(liveUiSeams.carriers).toBe(carriersUnavailable);
    await expect(
      liveUiSeams.carriers({ kind: "broadcast", url: "" }, "t"),
    ).rejects.toBeInstanceOf(CarrierBlocked);

    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const active = liveUiSeams.carriers;
    expect(active).not.toBe(carriersUnavailable);
    // No plan has resolved in this realm: a socket carrier is not allowed.
    await expect(
      active({ kind: "nostr", url: "wss://relay.example.test" }, "t"),
    ).rejects.toThrow("capability-not-approved");
    // ntfy goes through the context's port, under the declared purpose.
    const ntfy = await active(
      { kind: "ntfy", url: "https://ntfy.example.test" },
      "t",
    );
    ntfy.close();
    expect(t.egressCalls).toEqual([
      {
        input: `https://ntfy.example.test/t/json?since=${Math.floor(startedAt / 1000)}`,
        capability: "sharing.live",
        purpose: CARRIER_PURPOSE,
      },
    ]);

    await handle.dispose();
    expect(liveUiSeams.carriers).toBe(carriersUnavailable);
  });

  it("does not let a stale activation's disposal take a newer one's carriers", async () => {
    const first = await runtime.capabilityRuntime.activate(
      createTestContext().ctx,
    );
    const second = await runtime.capabilityRuntime.activate(
      createTestContext().ctx,
    );
    const current = liveUiSeams.carriers;
    await first.dispose();
    expect(liveUiSeams.carriers).toBe(current);
    await second.dispose();
    expect(liveUiSeams.carriers).toBe(carriersUnavailable);
  });
});
