/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextWithPorts } from "../ports-b.js";
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

  it("registers its Settings panel and disposes it (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "vault.interop-formats",
      kinds: ["settings-panel"],
      count: 1,
    });
  });

  it("offers the Formats panel under Security and revokes it on dispose", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(
      t.ctx as ContextWithPorts,
    );
    const record = t.registered.find(
      (entry) => entry.kind === "settings-panel",
    );
    expect(record?.entry).toMatchObject({
      id: "formats-interoperability",
      category: "security",
    });
    // Nothing is fetched and no Wasm is pulled by activating: KDBX and
    // Argon2 are import()ed from `parse()`, not from the module graph.
    expect(t.egressCalls).toEqual([]);
    expect(t.liveKinds()).toContain("settings-panel");
    await handle.dispose();
    expect(t.liveKinds()).not.toContain("settings-panel");
    await handle.dispose();
    expect(record?.revokeCalls).toBe(1);
  });
});
