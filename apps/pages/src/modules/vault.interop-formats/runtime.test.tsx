/** @vitest-environment jsdom */
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

  it("registers its Import key and Settings panels and disposes them (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "vault.interop-formats",
      kinds: ["settings-panel", "vault-command"],
      count: 3,
    });
  });

  it("puts the Import key in the vault path strip and revokes it on dispose", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const record = t.registered.find((entry) => entry.kind === "vault-command");
    expect(record?.entry).toBe(runtime.IMPORT_COMMAND);
    expect(runtime.IMPORT_COMMAND).toMatchObject({ id: "import", order: 10 });
    // The key reads nothing until a file is picked: activating fetched none.
    expect(t.egressCalls).toEqual([]);
    await handle.dispose();
    expect(t.liveKinds()).not.toContain("vault-command");
    expect(record?.revokeCalls).toBe(1);
  });

  it("offers the Formats panel under Security and revokes it on dispose", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
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

  it("offers the Sealed store panel under Vaults, never on the Export key", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const panels = t.registered
      .filter((entry) => entry.kind === "settings-panel")
      .map((entry) => entry.entry);
    expect(panels).toContainEqual(
      expect.objectContaining({ id: "sealed-store", category: "vaults" }),
    );
    // The manifest is plain text: only the Import key is a vault command.
    expect(
      t.registered.filter((entry) => entry.kind === "vault-command"),
    ).toHaveLength(1);
    expect(t.egressCalls).toEqual([]);
    await handle.dispose();
    expect(t.liveKinds()).not.toContain("settings-panel");
  });
});
