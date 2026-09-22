/** @vitest-environment jsdom */
import type { RegistrationHandle } from "@opensesame/capability-composition";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContextWithPorts,
  SettingsPanelContribution,
} from "../ports-b.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("vault.interop-formats runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("vault.interop-formats");
  });

  it("registers no shell contribution of its own (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "vault.interop-formats",
      kinds: [],
      count: 0,
    });
  });

  it("offers the Formats panel under Security and revokes it on dispose", async () => {
    const revoke = vi.fn();
    const registerSettingsPanel = vi.fn(
      (_entry: SettingsPanelContribution): RegistrationHandle => ({
        kind: "settings-category",
        capability: "vault.interop-formats",
        generation: 1,
        revoke,
      }),
    );
    const t = createTestContext();
    const ctx: ContextWithPorts = { ...t.ctx, registerSettingsPanel };
    const handle = await runtime.capabilityRuntime.activate(ctx);
    expect(registerSettingsPanel.mock.calls[0]?.[0]).toMatchObject({
      id: "formats-interoperability",
      category: "security",
    });
    // Nothing is fetched and no Wasm is pulled by activating: KDBX and
    // Argon2 are import()ed from `parse()`, not from the module graph.
    expect(t.egressCalls).toEqual([]);
    await handle.dispose();
    expect(revoke).toHaveBeenCalledTimes(1);
    await handle.dispose();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("activates without the optional port", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.registered).toEqual([]);
    await handle.dispose();
  });
});
